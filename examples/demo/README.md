# adaptive-rate-limit · demo

An interactive showcase for `@dtl/adaptive-rate-limit`. Click buttons, hit limits, and watch the load factor respond to CPU load in real time.

## Quick start

```bash
# Requires Redis on localhost:6379
docker run -p 6379:6379 redis:7-alpine

# In this directory
npm install
npm start
# → http://localhost:3001
```

## What it shows

Three endpoint cards share a single 10-second rate-limit window (base limit 20):

| Endpoint | Cost | What it does |
|----------|------|-------------|
| `GET /api/ping` | 1 | Returns immediately |
| `GET /api/search` | 5 | Returns 20 simulated results |
| `GET /api/crunch` | 10 | Synchronous prime sieve — actually burns CPU |

The status bar at the top polls `/api/status` every 2 s and shows:
- **Load factor** — scales from 1.0 (normal) down to 0.3 as CPU climbs past the 60% threshold
- **CPU %** — current process CPU utilisation
- **Effective limit** — `floor(20 × loadFactor)`, the actual limit enforced right now

## Triggering adaptive load reduction

Spam the **Send Request** button on `/api/crunch`. Each request runs a synchronous prime sieve which spikes CPU. After a few seconds the load factor will drop and the effective limit will shrink — meaning you'll hit 429 faster even after the window resets.
