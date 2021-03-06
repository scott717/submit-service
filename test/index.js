const tape = require('tape');
const { fork } = require('child_process');
const toString = require('stream-to-string');
const proxyquire = require('proxyquire').noCallThru();
const getPort = require('get-port');

tape('success conditions', test => {
  test.test('port not specified in environment should default to 3103', t => {
    process.env.PORT = undefined;

    proxyquire('../index', {
      './app': {
        listen: (port) => {
          t.equals(port, 3103);
          t.end();
        }
      }
    });

  });

  test.test('port specified in environment should use it', t => {
    getPort().then(randomPort => {
      process.env.PORT = randomPort;

      proxyquire('../index', {
        './app': {
          listen: (port) => {
            t.equals(port, randomPort);
            t.end();
          }
        }
      });

    });

  });

});
