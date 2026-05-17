# 02 — API Design

## Public API

```js
const { createRateLimiter, createDebugRouter } = require('@you/adaptive-rate-limiter');
```

### `createRateLimiter(options)` → `express.Handler`

The middleware factory. Returns a middleware function suitable for `app.use()` or per-route mounting.

#### Options

```ts
interface RateLimiterOptions {
  // --- Redis ---
  redis: RedisOptions | IORedis;       // ioredis config or existing client
  keyPrefix?: string;                   // default: 'rl:'

  // --- Window ---
  windowMs: number;                     // required, must be >= 1000
  limit: number;                        // required base requests per window

  // --- Identifiers ---
  identifiers?: IdentifierConfig[];     // default: ['ip']
  // Each can be a string preset or { type, extractor } for custom

  // --- Cost weights ---
  routeCosts?: Record<string, number>;  // 'METHOD /path' → cost, plus 'default'
  costResolver?: (req) => number;       // override routeCosts entirely

  // --- Adaptive ---
  adaptive?: {
    enabled?: boolean;                  // default: false
    minFactor?: number;                 // default: 0.3
    maxFactor?: number;                 // default: 1.0
    pollIntervalMs?: number;            // default: 5000
    cpuThreshold?: number;              // % cpu where factor starts dropping, default 70
  };

  // --- Penalty ---
  penalty?: {
    enabled?: boolean;                  // default: false
    maxMultiplier?: number;             // default: 4 (limit dropped to 1/4)
    incrementPerViolation?: number;     // default: 0.25
    decayMs?: number;                   // default: 300_000 (5 min)
  };

  // --- Behavior ---
  failOpen?: boolean;                   // default: true (allow on Redis error)
  skipSuccessfulRequests?: boolean;     // default: false
  onLimit?: (req, res, info) => void;   // custom 429 handler

  // --- Response ---
  standardHeaders?: boolean;            // default: true (IETF draft headers)
  legacyHeaders?: boolean;              // default: false (X-RateLimit-*)
}
```

#### Identifier presets

| Preset | Extractor |
|---|---|
| `'ip'` | `req.ip` (respects `trust proxy`) |
| `'user'` | `req.user?.id` |
| `'apiKey'` | `req.headers['x-api-key']` |
| `'session'` | `req.sessionID` |

Custom:
```js
identifiers: [
  'ip',
  { type: 'tenant', extractor: (req) => req.headers['x-tenant-id'] },
]
```

If an extractor returns `null`/`undefined`, that identifier is skipped for that request (not treated as the string "undefined").

### `createDebugRouter(options)` → `express.Router`

```js
app.use('/ratelimit/debug', createDebugRouter({
  redis: redisClient,
  authToken: process.env.RL_DEBUG_TOKEN,  // required in production
}));
```

Endpoints:
- `GET /` — index of identifiers currently being tracked
- `GET /identifier/:type/:value` — full state for one identifier
- `GET /load` — current adaptive load factor and raw metrics
- `DELETE /identifier/:type/:value` — clear penalty + window (admin reset)

## Response contract

### Allowed request
Headers set:
```
RateLimit-Limit: 100
RateLimit-Remaining: 87
RateLimit-Reset: 42
RateLimit-Policy: 100;w=60
```

If multiple identifiers, the *tightest* (lowest remaining) drives the headers.

### Blocked request (429)
```
HTTP/1.1 429 Too Many Requests
Retry-After: 23
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 23

{
  "error": "rate_limited",
  "message": "Too many requests",
  "identifier": "ip",          // which identifier triggered
  "retryAfterMs": 23000,
  "penaltyApplied": true,      // true if penalty multiplier > 1
  "cost": 10                   // cost of this request
}
```

Note: `identifier` reveals *which* identifier triggered but never the value (don't echo back IPs/user IDs). This avoids confirming to an attacker which identifier you're tracking them by.

### Failed open (Redis down)
```
RateLimit-Status: degraded
```
Request passes through, no 429 headers set.

## Info object passed to `onLimit`

```ts
interface LimitInfo {
  identifier: { type: string };          // no value, see above
  limit: number;                          // effective limit after adjustments
  baseLimit: number;                      // original config limit
  current: number;                        // current count in window
  cost: number;                           // cost of this request
  windowMs: number;
  resetAt: number;                        // unix ms
  adaptiveFactor: number;
  penaltyMultiplier: number;
}
```

## Examples

### Minimal
```js
app.use(createRateLimiter({
  redis: { host: 'localhost' },
  windowMs: 60_000,
  limit: 100,
}));
```

### Full kitchen sink
```js
app.use(createRateLimiter({
  redis: redisClient,
  windowMs: 60_000,
  limit: 100,
  identifiers: ['ip', 'user', 'apiKey'],
  routeCosts: {
    'POST /api/ai/generate': 10,
    'POST /api/upload': 5,
    'GET /api/health': 0,
    default: 1,
  },
  adaptive: { enabled: true, cpuThreshold: 75 },
  penalty: { enabled: true, maxMultiplier: 4 },
  onLimit: (req, res, info) => {
    logger.warn({ info }, 'rate limited');
    res.status(429).json({ /* custom */ });
  },
}));
```

### Per-route mounting (different limits per route)
```js
const aiLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, ... });
const apiLimiter = createRateLimiter({ windowMs: 60_000, limit: 100, ... });

app.post('/api/ai/generate', aiLimiter, handler);
app.use('/api', apiLimiter);
```
