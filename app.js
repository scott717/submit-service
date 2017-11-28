const express = require('express');
const Router = require('express').Router;
const _ = require('lodash');
const request = require('request');
const csvParse = require( 'csv-parse' );
const through2 = require('through2');
const oboe = require('oboe');
const unzip = require('unzip-stream');
const morgan = require('morgan');
const toString = require('stream-to-string');
const { URL } = require('url');
const fs = require('fs');
const dbfstream = require('dbfstream');
const temp = require('temp');
const JSFtp = require('jsftp');

const winston = require('winston');
const logger = winston.createLogger({
  level: 'debug',
  transports: [
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

temp.track();

// matches:
// - MapServer/0
// - FeatureServer/13
// - MapServer/1/
const arcgisRegexp = /(Map|Feature)Server\/\d+\/?$/;

// if no source parameter was supplied, bail immediately
const preconditionsCheck = (req, res, next) => {
  if (!req.query.source) {
    res.status(400).type('text/plain').send('\'source\' parameter is required');
  } else {
    logger.debug({ source: req.query.source });
    next();
  }

};

function getProtocol(protocol) {
  if ('http:' === protocol || 'https:' === protocol) {
    return 'http';
  } else if ('ftp:' === protocol) {
    return 'ftp';
  }
}

// determine the protocol, type, and compression to make decisions easier later on
const determineType = (req, res, next) => {
  try {
    const source = new URL(req.query.source);

    // setup a working context
    res.locals.source = {
      coverage: {},
      data: source.href,
      source_data: {
        fields: [],
        results: []
      },
      conform: {}
    };

    if (arcgisRegexp.test(source.pathname)) {
      res.locals.source.type = 'ESRI';
      res.locals.source.conform.type = 'geojson';
    } else if (_.endsWith(source.pathname, '.geojson')) {
      res.locals.source.type = getProtocol(source.protocol);
      res.locals.source.conform.type = 'geojson';
    } else if (_.endsWith(source.pathname, '.csv')) {
      res.locals.source.type = getProtocol(source.protocol);
      res.locals.source.conform.type = 'csv';
    } else if (_.endsWith(source.pathname, '.zip')) {
      res.locals.source.type = getProtocol(source.protocol);
      res.locals.source.compression = 'zip';
    } else {
      res.status(400).type('text/plain').send('Unsupported type');
    }

  } catch (err) {
    logger.info(`Unable to parse URL from '${req.query.source}'`);
    res.status(400).type('text/plain').send(`Unable to parse URL from '${req.query.source}'`);

  }

  // only call next() if no response was previously sent (due to error or unsupported type)
  if (!res.headersSent) {
    next();
  }

};

// if the request protocol, type, and compression match, continue on this route
// otherwise move on to the next route
const typecheck = (protocol, type, compression) => (req, res, next) => {
  if (res.locals.source.type === protocol &&
      res.locals.source.conform.type === type &&
      res.locals.source.compression === compression) {
    next();
  } else {
    next('route');
  }

};

// helper functions bound to typecheck with specific parameters
const isArcgis = typecheck.bind(null, 'ESRI', 'geojson')();
const isHttpGeojson = typecheck.bind(null, 'http', 'geojson')();
const isHttpCsv = typecheck.bind(null, 'http', 'csv')();
const isHttpZip = typecheck.bind(null, 'http', undefined, 'zip')();
const isFtpZip = typecheck.bind(null, 'ftp', undefined, 'zip')();
const isFtpGeojson = typecheck.bind(null, 'ftp', 'geojson')();
const isFtpCsv = typecheck.bind(null, 'ftp', 'csv')();

// middleware that queries an Arcgis server for the first 10 records
const sampleArcgis = (req, res, next) => {
  logger.debug(`using arcgis sampler for ${res.locals.source.data}`);

  // build up a URL for querying an Arcgis server
  const url = new URL(`${res.locals.source.data}/query`);
  url.searchParams.append('outFields', '*');
  url.searchParams.append('where', '1=1');
  url.searchParams.append('resultRecordCount', '10');
  url.searchParams.append('resultOffset', '0');
  url.searchParams.append('f', 'json');

  oboe(url.href)
    .node('fields.*.name', name => {
      res.locals.source.source_data.fields.push(name);
    })
    .node('features.*.attributes', attributes => {
      res.locals.source.source_data.results.push(attributes);
    })
    .fail((err) => {
      let error_message = `Error connecting to Arcgis server ${res.locals.source.data}: `;

      if (err.thrown) {
        error_message += err.thrown.code;
      } else {
        error_message += `${err.body} (${err.statusCode})`;
      }

      logger.info(error_message);

      res.status(400).type('text/plain').send(error_message);

    })
    .done(() => {
      // this will happen when the list of results has been processed and
      // iteration still has no reached the 11th result, which is very unlikely
      next();
    });

};

// middleware that requests and streams a .geojson file, returning up to the first
// 10 records
const sampleHttpGeojson = (req, res, next) => {
  logger.debug(`using geojson sampler for ${res.locals.source.data}`);

  oboe(res.locals.source.data)
    .node('features[*].properties', properties => {
      res.locals.source.source_data.fields = _.keys(properties);
      res.locals.source.source_data.results.push(properties);
    })
    .node('features[9]', function() {
      // bail after the 10th result.  'done' does not get called after .abort()
      //  so next() must be called explicitly
      // must use full function() syntax for "this" reference
      this.abort();
      next();
    })
    .fail((err) => {
      let error_message = `Error retrieving file ${res.locals.source.data}: `;

      if (err.thrown) {
        error_message += err.thrown.code;
      } else {
        error_message += `${err.body} (${err.statusCode})`;
      }

      logger.info(error_message);

      res.status(400).type('text/plain').send(error_message);

    })
    .done(() => {
      // this will happen when the list of results has been processed and
      // iteration still has no reached the 11th result, which is very unlikely
      next();
    });

};

// middleware that requests and streams a .csv file, returning up to the first
// 10 records
const sampleHttpCsv = (req, res, next) => {
  logger.debug(`using csv sampler for ${res.locals.source.data}`);

  // save off request so it can be error-handled and piped later
  const r = request(res.locals.source.data);

  // handle catastrophic errors like "connection refused"
  r.on('error', (err) => {
    const error_message = `Error retrieving file ${res.locals.source.data}: ${err.code}`;

    logger.info(error_message);

    res.status(400).type('text/plain').send(error_message);

  });

  // handle normal responses (including HTTP errors)
  r.on('response', (response) => {
    if (response.statusCode !== 200) {
      // something went wrong so save up the response text and return an error
      toString(r, (err, msg) => {
        let error_message = `Error retrieving file ${res.locals.source.data}`;
        error_message += `: ${msg} (${response.statusCode})`;

        logger.info(error_message);

        res.status(400).type('text/plain').send(error_message);

      });

    } else {
      logger.debug(`successfully retrieved ${res.locals.source.data}`);

      // otherwise everything was fine so pipe the response to CSV and collect records
      r.pipe(csvParse({
        skip_empty_lines: true,
        columns: true
      }))
      .pipe(through2.obj(function(record, enc, callback) {
        if (res.locals.source.source_data.results.length < 10) {
          res.locals.source.source_data.fields = _.keys(record);
          res.locals.source.source_data.results.push(record);
          callback();
        } else {
          // there are enough records so end the stream prematurely, handle in 'close' event
          this.destroy();
        }

      }))
      .on('close', () => {
        // stream was closed prematurely
        next();
      })
      .on('finish', () => {
        // stream was ended normally
        next();
      });

    }

  });

};

// middleware that requests and streams a compressed .zip file, returning up
// to the first 10 records
const sampleHttpZip = (req, res, next) => {
  logger.debug(`using zip sampler for ${res.locals.source.data}`);

  const r = request(res.locals.source.data);

  // handle catastrophic errors like "connection refused"
  r.on('error', (err) => {
    const error_message = `Error retrieving file ${res.locals.source.data}: ${err.code}`;
    logger.info(error_message);

    res.status(400).type('text/plain').send(error_message);

  });

  // handle normal responses (including HTTP errors)
  r.on('response', (response) => {
    if (response.statusCode !== 200) {
      // something went wrong so save up the response text and return an error
      toString(r, (err, msg) => {
        let error_message = `Error retrieving file ${res.locals.source.data}`;
        error_message += `: ${msg} (${response.statusCode})`;

        logger.info(error_message);

        res.status(400).type('text/plain').send(error_message);

      });

    } else {
      logger.debug(`successfully retrieved ${res.locals.source.data}`);

      // otherwise everything was fine so pipe the response to CSV and collect records
      r.pipe(unzip.Parse())
      .on('entry', entry => {
        if (_.endsWith(entry.path, '.csv')) {
          logger.debug(`treating ${entry.path} as csv`);
          res.locals.source.conform.type = 'csv';

          // process the .csv file
          entry.pipe(csvParse({
            skip_empty_lines: true,
            columns: true
          }))
          .pipe(through2.obj(function(record, enc, callback) {
            // must use full function() syntax for "this" reference
            if (res.locals.source.source_data.results.length < 10) {
              res.locals.source.source_data.fields = _.keys(record);
              res.locals.source.source_data.results.push(record);
              callback();
            } else {
              // there are enough records so end the stream prematurely, handle in 'close' event
              this.destroy();
            }

          }))
          .on('close', () => {
            // stream was closed prematurely
            next();
          })
          .on('finish', () => {
            // stream was ended normally
            next();
          });

        }
        else if (_.endsWith(entry.path, '.geojson')) {
          logger.debug(`treating ${entry.path} as geojson`);

          res.locals.source.conform.type = 'geojson';

          oboe(entry)
            .node('features.*.properties', properties => {
              res.locals.source.source_data.fields = _.keys(properties);
              res.locals.source.source_data.results.push(properties);
            })
            .node('features[9]', function() {
              // bail after the 10th result.  'done' does not get called after .abort()
              //  so next() must be called explicitly
              // must use full function() syntax for "this" reference
              this.abort();
              next();
            })
            .done(() => {
              // this will happen when the list of results has been processed and
              // iteration still has no reached the 11th result, which is very unlikely
              next();
            });

        }
        else if (_.endsWith(entry.path, '.dbf')) {
          logger.debug(`treating ${entry.path} as dbf`);

          // in the case of a DBF file, because there's no DBF parser that takes a stream,
          // write to a temporary file and read in that way
          res.locals.source.conform.type = 'shapefile';

          res.locals.source.source_data.results = [];

          // create a stream for writing the dbf file to
          const stream = temp.createWriteStream({ suffix: '.dbf' });

          // bookkeeping flag to determine if next() has already been called
          let next_was_called = false;

          // pipe the dbf contents from the .zip file to a stream
          entry.pipe(stream).on('finish', () => {
            const dbf = dbfstream(stream.path, 'utf-8');

            // there's a header so pull the field names from it
            dbf.on('header', (header) => {
              res.locals.source.source_data.fields = header.listOfFields.map(f => f.name);
            });

            // found a row
            dbf.on('data', (record) => {
              // if there aren't 10 records in the array yet and the record isn't deleted, then add it
              if (res.locals.source.source_data.results.length < 10 && !record['@deleted']) {
                // add all the non-@ attributes
                res.locals.source.source_data.results.push(
                  _.pickBy(record, (value, key) => !_.startsWith(key, '@')));

              } else if (!next_was_called) {
                // there are 10 records, so bail now
                next_was_called = true;
                return next();

              }

            });

            // stream ended, so call next() if it hasn't already
            dbf.on('end', () => {
              if (!next_was_called) {
                return next();
              }

            });

          });

        }
        else {
          // this is a file that's currently unsupported so drain it so memory doesn't get full
          logger.debug(`skipping ${entry.path}`);
          entry.autodrain();

        }

      })
      .on('finish', () => {
        if (!res.locals.source.conform.type) {
          logger.info('Could not determine type from zip file');
          res.status(400).type('text/plain').send('Could not determine type from zip file');
        }

      });
    }

  });

};

// middleware that requests and streams a compressed .zip file, returning up
// to the first 10 records
const sampleFtpZip = (req, res, next) => {
  logger.debug(`using zip sampler for ${res.locals.source.data}`);

  const url = new URL(res.locals.source.data);

  const options = {
    host: url.hostname,
    port: url.port,
    user: url.username,
    pass: url.password
  };

  const ftp = new JSFtp(options);

  ftp.get(url.pathname, (err, zipfile) => {
    if (err) {
      console.error(err);
      return;
    }

    zipfile.pipe(unzip.Parse())
    .on('entry', entry => {
      if (_.endsWith(entry.path, '.csv')) {
        logger.debug(`treating ${entry.path} as csv`);
        res.locals.source.conform.type = 'csv';

        // process the .csv file
        entry.pipe(csvParse({
          skip_empty_lines: true,
          columns: true
        }))
        .pipe(through2.obj(function(record, enc, callback) {
          // must use full function() syntax for "this" reference
          if (res.locals.source.source_data.results.length < 10) {
            res.locals.source.source_data.fields = _.keys(record);
            res.locals.source.source_data.results.push(record);
            callback();
          } else {
            // there are enough records so end the stream prematurely, handle in 'close' event
            this.destroy();
          }

        }))
        .on('close', () => {
          // stream was closed prematurely
          ftp.raw('quit', (err, data) => {
            return next();
          });
        })
        .on('finish', () => {
          // stream was ended normally
          ftp.raw('quit', (err, data) => {
            return next();
          });
        });

      }
      else if (_.endsWith(entry.path, '.dbf')) {
        logger.debug(`treating file as dbf`);

        // in the case of a DBF file, because there's no DBF parser that takes a stream,
        // write to a temporary file and read in that way
        res.locals.source.conform.type = 'shapefile';

        res.locals.source.source_data.results = [];

        // create a stream for writing the dbf file to
        const stream = temp.createWriteStream({ suffix: '.dbf' });

        // bookkeeping flag to determine if next() has already been called
        let next_was_called = false;

        // pipe the dbf contents from the .zip file to a stream
        entry.pipe(stream).on('finish', () => {
          const dbf = dbfstream(stream.path, 'utf-8');

          // there's a header so pull the field names from it
          dbf.on('header', (header) => {
            res.locals.source.source_data.fields = header.listOfFields.map(f => f.name);
          });

          // found a row
          dbf.on('data', (record) => {
            // if there aren't 10 records in the array yet and the record isn't deleted, then add it
            if (res.locals.source.source_data.results.length < 10 && !record['@deleted']) {
              // add all the non-@ attributes
              res.locals.source.source_data.results.push(
                _.pickBy(record, (value, key) => !_.startsWith(key, '@')));

            } else if (!next_was_called) {
              // there are 10 records, so bail now
              next_was_called = true;

              ftp.raw('quit', (err, data) => {
                return next();
              });

            }

          });

          // stream ended, so call next() if it hasn't already
          dbf.on('end', () => {
            if (!next_was_called) {
              ftp.raw('quit', (err, data) => {
                return next();
              });

            }

          });

        });

      }
      else if (_.endsWith(entry.path, '.geojson')) {
        logger.debug(`treating ${entry.path} as geojson`);

        res.locals.source.conform.type = 'geojson';

        oboe(entry)
          .node('features.*.properties', properties => {
            res.locals.source.source_data.fields = _.keys(properties);
            res.locals.source.source_data.results.push(properties);
          })
          .node('features[9]', function() {
            // bail after the 10th result.  'done' does not get called after .abort()
            //  so next() must be called explicitly
            // must use full function() syntax for "this" reference
            this.abort();
            ftp.raw('quit', (err, data) => {
              return next();
            });

          })
          .done(() => {
            // this will happen when the list of results has been processed and
            // iteration still has no reached the 11th result, which is very unlikely
            ftp.raw('quit', (err, data) => {
              return next();
            });
          });

      }
      else {
        // this is a file that's currently unsupported so drain it so memory doesn't get full
        logger.debug(`skipping ${entry.path}`);
        entry.autodrain();

      }

    })
    .on('finish', () => {
      if (!res.locals.source.conform.type) {
        logger.info('Could not determine type from zip file');
        res.status(400).type('text/plain').send('Could not determine type from zip file');
      }

    });


  });

};

// middleware that requests and streams a compressed .zip file, returning up
// to the first 10 records
const sampleFtpGeojson = (req, res, next) => {
  logger.debug(`using geojson sampler for ${res.locals.source.data}`);

  const url = new URL(res.locals.source.data);

  const options = {
    host: url.hostname,
    port: url.port,
    user: url.username,
    pass: url.password
  };

  const ftp = new JSFtp(options);

  ftp.get(url.pathname, (err, geojson_stream) => {
    if (err) {
      console.error(err);
      return;
    }

    // get() returns a paused stream, so resume it
    geojson_stream.resume();

    oboe(geojson_stream)
      .node('features.*.properties', properties => {
        res.locals.source.source_data.fields = _.keys(properties);
        res.locals.source.source_data.results.push(properties);
      })
      .node('features[9]', function() {
        // bail after the 10th result.  'done' does not get called after .abort()
        //  so next() must be called explicitly
        // must use full function() syntax for "this" reference
        this.abort();
        ftp.raw('quit', (err, data) => {
          return next();
        });

      })
      .fail(err => {
        console.error(err);
        return next();
      })
      .done(() => {
        // this will happen when the list of results has been processed and
        // iteration still has no reached the 11th result, which is very unlikely
        ftp.raw('quit', (err, data) => {
          return next();
        });
      });

  });

};

// middleware that requests and streams a compressed .zip file, returning up
// to the first 10 records
const sampleFtpCsv = (req, res, next) => {
  logger.debug(`using csv sampler for ${res.locals.source.data}`);

  const url = new URL(res.locals.source.data);

  const options = {
    host: url.hostname,
    port: url.port,
    user: url.username,
    pass: url.password
  };

  const ftp = new JSFtp(options);

  ftp.get(url.pathname, (err, csv_stream) => {
    if (err) {
      console.error(err);
      return;
    }

    // get() returns a paused stream, so resume it
    csv_stream.resume();

    // otherwise everything was fine so pipe the response to CSV and collect records
    csv_stream.pipe(csvParse({
      skip_empty_lines: true,
      columns: true
    }))
    .pipe(through2.obj(function(record, enc, callback) {
      if (res.locals.source.source_data.results.length < 10) {
        res.locals.source.source_data.fields = _.keys(record);
        res.locals.source.source_data.results.push(record);
        callback();
      } else {
        // there are enough records so end the stream prematurely, handle in 'close' event
        this.destroy();
      }

    }))
    .on('close', () => {
      // stream was closed prematurely
      ftp.raw('quit', (err, data) => {
        return next();
      });
    })
    .on('finish', () => {
      // stream was ended normally
      ftp.raw('quit', (err, data) => {
        return next();
      });
    });

  });

};

// middleware that outputs the accumulated metadata, fields, and sample results
const output = (req, res, next) => {
  res.status(200).send(res.locals.source);
};

module.exports = () => {
  const app = express();
  app.use(morgan('combined'));

  // setup a router that only handles Arcgis sources
  const arcgisRouter = express.Router();
  arcgisRouter.get('/fields', isArcgis, sampleArcgis);

  // setup a router that only handles .geojson files
  const httpGeojsonRouter = express.Router();
  httpGeojsonRouter.get('/fields', isHttpGeojson, sampleHttpGeojson);

  // setup a router that only handles .csv files
  const httpCsvRouter = express.Router();
  httpCsvRouter.get('/fields', isHttpCsv, sampleHttpCsv);

  // setup a router that only handles .zip files
  const httpZipRouter = express.Router();
  httpZipRouter.get('/fields', isHttpZip, sampleHttpZip);

  // setup a router that only handles .zip files
  const ftpZipRouter = express.Router();
  ftpZipRouter.get('/fields', isFtpZip, sampleFtpZip);

  // setup a router that only handles .geojson files via FTP
  const ftpGeojsonRouter = express.Router();
  ftpGeojsonRouter.get('/fields', isFtpGeojson, sampleFtpGeojson);

  // setup a router that only handles .csv files via FTP
  const ftpCsvRouter = express.Router();
  ftpCsvRouter.get('/fields', isFtpCsv, sampleFtpCsv);

  app.get('/fields',
    preconditionsCheck,
    determineType,
    arcgisRouter,
    httpGeojsonRouter,
    httpCsvRouter,
    httpZipRouter,
    ftpZipRouter,
    ftpGeojsonRouter,
    ftpCsvRouter,
    output
  );

  // expose testing UI
  app.use(express.static(__dirname + '/public'));

  return app;

};
