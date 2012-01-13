
/**
 * Module dependencies.
 */

var proxy = require('http-proxy')
  , RoutingProxy = proxy.RoutingProxy
  , EventEmitter = require('events').EventEmitter
  , debug = require('debug')('distributor')

/**
 * Module exports.
 */

module.exports = exports = Distributor;

/**
 * Version.
 *
 * @api public
 */

exports.version = '0.1.0';

/**
 * Distributor factory/constructor.
 *
 * @param {http.Server} server that acts as balancer
 * @api public
 */

function Distributor (server) {
  if (global == this) return new Distributor(server);

  this.server = server;
  this.proxy = new RoutingProxy;
  this.middleware = {
      ws: { all: [this.defaultWS], error: [this.defaultWSError] }
    , http: { all: [this.defaultHTTP], error: [this.defaultHTTPError] }
  };

  var self = this;
  server.on('request', function (req, res) {
    self.onRequest(req, res);
  });
  server.on('upgrade', function (req, socket, head) {
    self.onUpgrade(req, socket, head);
  });
}

/**
 * Inherits from EventEmitter.
 */

Distributor.prototype.__proto__ = EventEmitter.prototype;

/**
 * Captures the `ws` namespace and sets the state.
 */

Distributor.prototype.__defineGetter__('ws', function () {
  this.useWS = true;
});

/**
 * Appends a middleware.
 *
 * @return {Distributor} for chaining
 * @api public
 */

Distributor.prototype.use = function (fn) {
  var stack = this.middleware;

  if (this.useWS) {
    stack = stack.ws;
  } else {
    stack = stack.http;
  }

  if (4 == fn.length) {
    stack = stack.error;
  } else {
    stack = stack.all;
  }

  // make sure we keep the default middlewares last
  stack.splice(stack.length - 1, 0, fn);

  this.useWS = false;

  return this;
};

/**
 * Prepares a request for middleware execution.
 *
 * @param {http.ServerRequest} incoming request
 * @return {http.ServerRequest} processed request
 * @api private
 */

Distributor.prototype.prepare = function (req) {
  req.buf = this.proxy.buffer(req);
  return req;
};

/**
 * Handles regular http requests.
 *
 * @api private
 */

Distributor.prototype.onRequest = function (req, res) {
  var self = this;

  // set up buffering
  req.buf = proxy.buffer(req);

  // set up buffering cleanup
  function onFinish () {
    req.buf.destroy();
  }
  res.on('finish', onFinish);

  var stack = this.middleware.http;

  this.run(stack.all, [req, res], function (port, host) {
    if (port instanceof Error) {
      self.run(stack.error, [port, req, res]);
    } else {
      res.removeListener('finish', onFinish);
      var proxy = { port: port, host: host || 'localhost', buffer: req.buf };
      self.proxy.proxyRequest(req, res, proxy);
    }
  });
};

/**
 * Handles http upgrades.
 *
 * @api private
 */

Distributor.prototype.onUpgrade = function (req, socket, head) {
  var self = this;

  // set up buffering
  req.buf = proxy.buffer(req);

  // append legacy `.head`
  req.head = head;

  // set up buffering cleanup
  function onClose () {
    req.buf.destroy();
  }
  socket.on('close', onClose);

  var stack = this.middleware.ws;

  self.run(stack.all, [req, socket], function (port, host) {
    if (port instanceof Error) {
      debug('running error middleware for ws request');
      self.run(stack.error, [port, req, res]);
    } else {
      debug('proxying ws request');
      socket.removeListener('close', onClose);
      var proxy = { port: port, host: host || 'localhost', buffer: req.buf };
      self.proxy.proxyUpgrade(req, res, req.head, proxy);
    }
  });
};

/**
 * Runs a stack of middleware.
 *
 * @param {Array} stack of functions
 * @param {Array} parameters to pass to middleware
 * @param {Function} called when a middleware calls next with parameters
 * @api private
 */

Distributor.prototype.run = function (stack, params, onNext) {
  var l = params.length;

  function step (i) {
    params[l] = function next () {
      if (arguments.length) return onNext.apply(null, arguments);
      step(++i);
    };
    stack[i].apply(null, params);
  }

  step(0);
};

/**
 * Default handler middleware.
 *
 * @api private
 */

Distributor.prototype.defaultHTTP = function (req, res, next) {
  debug('executing default request middleware');
  res.writeHead(501);
  res.end();
};

/**
 * Default error handler middleware.
 *
 * @api private
 */

Distributor.prototype.defaultHTTPError = function (err, req, res, next) {
  debug('executing default request error middleware');

  if ('development' == process.env.NODE_ENV) {
    res.writeHead(500, {
        'Content-Type': 'text/plain'
      , 'Content-Length': Buffer.byteLength(err.stack)
    });
    res.end(err.stack);
  } else {
    res.writeHead(500);
    res.end();
  }
};

/**
 * Default ws handler middleware
 */

Distributor.prototype.defaultWS = function (err, req, socket, head) {
  debug('executing default ws middleware');
  socket.end();
};

/**
 * Default ws error handler middleware
 */

Distributor.prototype.defaultWSError = function (err, req, socket, head) {
  debug('executing default ws error middleware');
  socket.end();
};
