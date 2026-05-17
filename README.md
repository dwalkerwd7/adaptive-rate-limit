# Adaptive Rate Limiter Middleware

A production-leaning Express middleware that goes beyond `express-rate-limit` and `rate-limit-redis` with per-route cost weights, adaptive limits based on server load, identifier chaining, and penalty scoring.

## Why This Exists

Existing rate limiter packages handle the basics (fixed window, sliding window, token bucket) but treat every request the same, ignore server health, and can't combine multiple identifiers. This middleware addresses all three gaps and adds escalating penalties for repeat offenders.

## Feature Set

1. **Sliding window in Redis** — accurate windowing using sorted sets
2. **Per-route cost weights** — expensive endpoints cost more tokens
3. **Identifier chaining** — limit by IP + user ID + API key simultaneously
4. **Adaptive limits** — tighten under high CPU load, relax when idle
5. **Penalty scoring** — repeat 429s tighten future windows
6. **Debug dashboard** — live Redis state at `/ratelimit/debug`

## Project Structure

```
rate-limiter/
├── src/
│   ├── index.js                 # Public API export
│   ├── middleware.js            # Express middleware factory
│   ├── strategies/
│   │   └── sliding-window.js    # Sliding window implementation
│   ├── identifiers/
│   │   └── chain.js             # Identifier chaining logic
│   ├── adaptive/
│   │   └── load-monitor.js      # CPU/load polling
│   ├── penalty/
│   │   └── scorer.js            # Penalty tracking
│   ├── dashboard/
│   │   └── debug-route.js       # /ratelimit/debug
│   └── redis/
│       └── client.js            # Redis connection wrapper
├── test/
│   ├── sliding-window.test.js
│   ├── identifier-chain.test.js
│   ├── adaptive.test.js
│   ├── penalty.test.js
│   └── integration.test.js
├── docs/                        # The planning docs you're reading
├── examples/
│   └── basic-app.js
└── package.json
```

## Tech Stack

- Node.js 20+
- Express 4
- ioredis (better Lua scripting support than `redis` package)
- Vitest (faster than Jest, ESM-native)
- Supertest (HTTP assertions)

## Documentation Index

Read these in order. Each one is a context file you can hand Claude when reviewing your code for that section.

1. **`01-architecture.md`** — how the pieces fit together, data flow, Redis key schema
2. **`02-api-design.md`** — the public API surface, configuration options, return values
3. **`03-implementation-plan.md`** — day-by-day breakdown with task-level scope
4. **`04-redis-schema.md`** — every key, value type, TTL, and Lua script
5. **`05-testing-strategy.md`** — what to test, how to simulate bursts, fixtures
6. **`06-review-checklist.md`** — what Claude should look for when reviewing your code

## How to Use This With Claude

For each feature you implement:

1. Read the relevant doc section yourself first
2. Write the code without Claude's help
3. Open a fresh chat, paste the relevant doc(s) + your code
4. Ask: "Review against the spec. Find bugs, missed edge cases, and security holes."
5. Iterate

The docs are your spec. Don't let Claude rewrite them — let Claude poke holes in your implementation against them.
