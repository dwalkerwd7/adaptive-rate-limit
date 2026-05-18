# 04 — Redis Schema

Every key, every script, every TTL.

## Key namespace

Default prefix: `rl:` (configurable via `keyPrefix`).

| Key pattern | Type | Purpose | TTL |
|---|---|---|---|
| `rl:window:<idType>:<idValue>` | Sorted Set | Sliding window entries | `windowMs * 2` |
| `rl:penalty:<idType>:<idValue>` | String | Current penalty multiplier | `decayMs` |
| `rl:meta:routes` | Hash | Route cost overrides (optional, for hot reload) | none |

### Why `windowMs * 2` TTL on the window key?

If TTL == windowMs, a key just hit by request 1 expires before the window has fully slid past that request. Doubling gives a safe margin. We're using sorted sets, so old entries are removed by `ZREMRANGEBYSCORE` during each check anyway — the TTL is just cleanup for inactive identifiers.

## Sorted set member encoding

Each request adds entries to the sorted set with `score = now` (unix ms). The member needs to be unique per request, otherwise duplicate scores at the exact same ms would collide.

**Member format:** `<now>:<random>` where random is 8 hex chars.

```
ZADD rl:window:ip:1.2.3.4 1731000000000 "1731000000000:a3f8c1d9"
```

For cost > 1, add N members in a single `ZADD` call (each with a different random suffix).

## The Lua script

`src/strategies/sliding-window.lua`:

```lua
-- KEYS[1] = window key
-- ARGV[1] = now (ms)
-- ARGV[2] = windowMs
-- ARGV[3] = limit (already adjusted for adaptive + penalty)
-- ARGV[4] = cost
-- ARGV[5..N] = member strings for new entries (one per cost unit)

local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

-- 1. Trim old entries
local cutoff = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- 2. Count current
local current = redis.call('ZCARD', key)

-- 3. Check
if current + cost > limit then
  -- Find when oldest entry expires (= resetAt for full reset)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetAt = oldest[2] and (tonumber(oldest[2]) + windowMs) or (now + windowMs)
  return { 0, current, limit, resetAt }
end

-- 4. Add new entries
for i = 5, 4 + cost do
  redis.call('ZADD', key, now, ARGV[i])
end

-- 5. Refresh TTL
redis.call('PEXPIRE', key, windowMs * 2)

local resetAt = now + windowMs
return { 1, current + cost, limit, resetAt }
```

Return values: `{ allowed (0|1), currentCount, effectiveLimit, resetAtMs }`.

## Penalty key operations

### Read penalty multiplier
```
GET rl:penalty:user:u_123
→ "1.75" or nil
```
Parse as float, default to 1.0 if missing.

### Record violation
```lua
-- KEYS[1] = penalty key
-- ARGV[1] = increment
-- ARGV[2] = maxMultiplier
-- ARGV[3] = decayMs

local current = tonumber(redis.call('GET', KEYS[1])) or 1.0
local new = math.min(current + tonumber(ARGV[1]), tonumber(ARGV[2]))
redis.call('SET', KEYS[1], tostring(new), 'PX', tonumber(ARGV[3]))
return tostring(new)
```

Why a Lua script for this too? Atomicity. Without it, two parallel violations could read the same `current` and both write `current + 0.25`, losing one increment. Not catastrophic, but the script costs nothing extra and removes the race.

## Identifier value normalization

Before building the key:
- Lowercase the identifier value
- Strip whitespace
- For IPs: parse and re-stringify to canonical form (IPv6 has multiple representations of the same address)
- For email-like user IDs: lowercase
- Truncate to 256 chars (defensive against absurdly long header values)

Bad input handling — if an identifier value contains `:` or other key-delimiter characters, this could let an attacker forge keys. **Hash the value with SHA-256 and use the first 32 hex chars instead of the raw value.** Keys become:

```
rl:window:ip:<sha256(ip)[:32]>
```

Tradeoff: debug dashboard can't show you the raw IP from the key — you'd need a separate reverse index, or accept that the dashboard shows hashes. For day-2 scope, hashes are fine. Add a comment in the dashboard explaining this.

## Estimated memory footprint

Each window entry is ~30 bytes in the sorted set. 100 req/min/identifier × 100k identifiers × 30 bytes = ~300 MB worst case. Penalty keys are tiny (~50 bytes each).

For a side project, plenty of room. For production, you'd want to monitor `INFO memory` and possibly add identifier-level TTLs based on activity.

## Failure scenarios

| Failure | Behavior |
|---|---|
| Redis unreachable on startup | Middleware logs warning, fails open for all requests |
| Redis disconnects mid-request | The single failing request fails open, ioredis retries reconnection |
| Lua script error | Log full error, fail open for that request |
| Clock skew between app servers | Each app server uses its own clock; sliding window is approximate anyway. Acceptable. |
| Redis memory full | Writes fail, fail open. (Configure Redis with `maxmemory-policy allkeys-lru` for graceful degradation.) |
