var url   = require('url');
var redis = require('redis');
var zlib  = require('zlib');

// Send function that gzips if allowed
var send = function(req, res, html) {
  res.setHeader('Content-Type', 'text/html;charset=UTF-8');
  if (false && req.headers['accept-encoding'] && req.headers['accept-encoding'].indexOf('gzip') >= 0) {
      res.setHeader('Content-Encoding', 'gzip');
      zlib.gzip(html, function(err, result) {
        console.log('Sending cached gzipped html');
        if(Buffer.isBuffer(html)) {
          res.setHeader('Content-Length', html.length);
        } else {
          res.setHeader('Content-Length', Buffer.byteLength(html, 'utf8'));
        }
        res.writeHead(200);
        res.write(result);
        res.end();
      });
  } else {
      res.removeHeader('Content-Encoding');
      console.log('Sending cached html');
      res.send(200, html);
  }
};


/**
 * Basic Options
 * redis_url (string) - Redis hostname (defaults to localhost)
 * ttl (int) - TTL before a cache is considered old, it will still be served though.
 * dead (int) - If cached value is older we will not serve it.
 * build (int) - max building time, default 20 000ms
 */
module.exports = function(options) {

  var redis_url = options.redis_url || process.env.REDISTOGO_URL || process.env.REDISCLOUD_URL ||
                  process.env.REDISGREEN_URL || process.env.REDIS_URL || "redis://127.0.0.1:6379";

  options.ttl = options.ttl || 86400;
  options.dead = options.dead || 1000*60*60*24*7*2;
  options.build = options.build || 20000;

  // Parse out the connection vars from the env string.
  var connection = url.parse(redis_url);
  var client = redis.createClient(connection.port, connection.hostname);
  var last_error = "";
  var last_end_message = "";

  // Parse out password from the connection string
  if (connection.auth) {
      client.auth(connection.auth.split(":")[1]);
  }

  // Ping redis every 180 seconds to keep connection alive
  setInterval(function() {
    if (client.connected) {
      client.ping();
    }
  }, 1000 * 180);

  // Catch all error handler. If redis breaks for any reason it will be reported here.
  // Since we do this redis will reconnect if needed
  client.on("error", function (err) {
      if(last_error === err.toString()) {
        // Swallow the error for now
      } else {
        last_error = err.toString();
        console.log("Redis Cache Error: " + err);
      }
  });
  //
  client.on("ready", function () {
      console.log("Redis Cache Connected");
  });

  client.on("end", function (err) {
    if(err) {
      err = err.toString();
      if(last_end_message == err) {
        // Swallow the error for now
      } else {
        last_end_message = err;
        console.log("Redis Cache Connection Closed. Will now bypass redis until it's back.");
      }
    }
  });

  return {
      beforePhantomRequest: function (req, res, next) {
          if (req.method !== 'GET' || !client.connected) {
              return next();
          }
          var now = Date.now();

          // Just tell the others that we're building already.
          // then call next()
          var buildAndNext = function() {
            client.hmset(req.prerender.url, {
              building: now
            }, next);
          };

          client.hgetall(req.prerender.url, function(err, result) {
            console.log('hmget', req.prerender.url, err)
            if (!err && result && result.html) {

                //Yay we have a cached value. Let's see if its dead
                var created = parseInt(result.created, 10);

                if (isNaN(created) || now - created > options.dead) {
                  console.log('Value is dead. rebuilding');
                  buildAndNext(); // Dead values are just ignored.
                  return;
                }

                console.log('sending cached value');
                // The cached value is not dead so let's return it.
                send(req, res, result.html);

                // Is it old enough to initiate a rebuilding of cache?
                if (now - created > options.ttl) {
                  console.log('ttl has timed out');
                  // Check if someone is already building
                  var building = parseInt(result.building, 10);
                  if (!isNaN(building) && now - building <= options.build) {
                    // Someone has initiated a build inside of options build time (i.e default 20s)
                    // so we bail out and don't build. This is an optimization.
                    console.log('...but we are already building');
                    return;
                   }
                  // Tell the prerender server that it should not send any results.
                  console.log('dont send and rebuild');
                  req.prerender.dontSend = true;
                  buildAndNext();
                } else {
                  console.log('Time left to live ', options.ttl - (now - created));
                }
                // If we get here we *don't* call next() since we like to stop the request here.

            } else {
              // No cached result
              console.log('no cached results');
              buildAndNext();
            }
          });
      },

      afterPhantomRequest: function (req, res, next) {
          console.log('Client connected',client.connected);
          if (!client.connected) {
              return next();
          }
          // Don't cache anything that didn't result in a 200. This is to stop caching of 3xx/4xx/5xx status codes
          // Basic empty page test, just empty body and head + title and doctype is about 78
          // charachters so we check if we have at least 100.
          if (req.prerender.statusCode === 200 && req.prerender.documentHTML &&
              req.prerender.documentHTML.length > 100) {
              console.log('Setting cached value', req.prerender.url)
              client.hmset(req.prerender.url, {
                created: Date.now(),
                html: req.prerender.documentHTML
              }, function(res) {
                console.log('its done', res)
              });
          }
          next();
      }
  };
}
