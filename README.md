Slightly hacked version
=======================

Always sends the cached version, even if its old. But the let prerender update the cache so
*next* time it's updated.

This favors speed instead of correctness.

Usage:

```js
server.use(require('prerender-redis-cache')({
  ttl: 1000,
  dead: 1000*60,
  redis_url: 'redis://127.0.0.1:6379'
}));
```
