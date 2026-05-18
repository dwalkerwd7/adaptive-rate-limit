# 06 — Review Checklist

Hand this doc to Claude along with your code when you want a critical review. The point is to poke holes, not to praise.

## Universal checks (every module)

- [ ] All error paths logged? Are any errors swallowed silently?
- [ ] Does this work under concurrent load? Any read-modify-write without atomicity?
- [ ] Are inputs validated before being used in Redis keys, regex, or shell-like operations?
- [ ] Are there assumptions about input shape that could break on malformed/missing data?
- [ ] Does the public API match `02-api-design.md` exactly? Any added or missing options?
- [ ] Is there state that persists across requests that shouldn't?
- [ ] Are timers/intervals cleaned up? (Memory leak hunting)

## Sliding window strategy

- [ ] Does the Lua script trim old entries *before* checking the count?
- [ ] Does cost > 1 add multiple unique members, or does ZADD with same score collapse them?
- [ ] What happens if `limit` is 0 or negative? (Should fail loudly at config time, not at request time)
- [ ] What if `cost` is 0? Should it still bump the window? (Probably yes — see `routeCosts['GET /health'] = 0`)
- [ ] What if the cost exceeds the limit in a single request? Behavior should be: blocked, nothing written.
- [ ] Is the resetAt calculation correct when the window is empty?
- [ ] Are you using `PEXPIRE` (ms) not `EXPIRE` (seconds)?
- [ ] Does the script return the *adjusted* limit (after adaptive/penalty) for header purposes?

## Identifier chaining

- [ ] If two identifiers both block, which one is reported? (Should be deterministic, document the tiebreaker)
- [ ] Are extractor exceptions caught, or do they crash the middleware?
- [ ] Are values normalized consistently between extractors? (Lowercase IPs, trim whitespace)
- [ ] Are values hashed before being used as Redis keys? (`04-redis-schema.md` requires this)
- [ ] What if all extractors return null? (Should fail open with a warning, not crash)
- [ ] If `trust proxy` isn't set, is `req.ip` reliable?
- [ ] Are there enough identifier types that the "tightest wins" logic does N parallel Redis calls, not N sequential?

## Per-route cost weights

- [ ] How is the route key resolved? Express `req.route?.path` is set after routing — does middleware see it?
- [ ] What about wildcards in routes (`/api/users/:id`)? Does the cost map need patterns?
- [ ] What about case sensitivity? `'POST /API/X'` vs `'post /api/x'`?
- [ ] If `costResolver` and `routeCosts` are both provided, which wins? (Document it)
- [ ] Cost of 0 should still record a request for visibility, but shouldn't count toward the limit. Confirm both.

## Adaptive load monitor

- [ ] Is the CPU calculation actually a *delta* between samples, or are you reading cumulative values?
- [ ] What about multi-core? `process.cpuUsage()` returns sum across cores — should you divide by `os.cpus().length`?
- [ ] If `pollIntervalMs` is too low, polling itself spikes CPU. Minimum sane value?
- [ ] When the monitor first starts (no previous sample), what does `getLoadFactor()` return?
- [ ] If you have N middleware instances (per-route), are they each starting their own monitor? They should share one.
- [ ] Does `stop()` actually allow Node to exit cleanly? (Unreffed timer or unhandled handle?)

## Penalty scorer

- [ ] Is `recordViolation` truly fire-and-forget, or does it block the 429 response?
- [ ] If `recordViolation` fails (Redis down), is the error logged? Does the request still return 429?
- [ ] Does the multiplier cap actually trigger before exceeding `maxMultiplier`?
- [ ] What if a request is blocked by *multiple* identifiers — does each one get a violation recorded? (Probably yes, document it)
- [ ] Is there a way to manually reset a penalty? (Debug dashboard has DELETE — confirm it kills the penalty key too)
- [ ] What if `decayMs` is shorter than `windowMs`? Penalty disappears mid-window — intended?

## Debug dashboard

- [ ] Is `KEYS` used anywhere? Replace with `SCAN`. `KEYS` blocks Redis.
- [ ] Is the auth token comparison constant-time? (Use `crypto.timingSafeEqual`)
- [ ] Does the dashboard work if zero identifiers are being tracked? (No keys found should be 200 with empty array, not 500)
- [ ] Is the dashboard mountable at any path, or hardcoded to `/ratelimit/debug`?
- [ ] If `authToken` is unset, what happens? (Should refuse to start in production, allow in development)
- [ ] Does DELETE clear both window *and* penalty keys for that identifier?

## Security-specific checks

- [ ] Can a malicious header value cause a Redis key explosion? (Hashing identifier values prevents this — confirm)
- [ ] Can the 429 response leak which identifier triggered? Acceptable to reveal the *type* (ip/user/apiKey) but not the value.
- [ ] Are debug route responses cacheable? They shouldn't be. Set `Cache-Control: no-store`.
- [ ] Is `X-Forwarded-For` trusted blindly? (Should require explicit `trust proxy` config)
- [ ] If `failOpen: true`, is that documented as a security tradeoff?
- [ ] Could the penalty system be weaponized? (Attacker spoofs IPs to penalize legit users — note this is fundamental to IP-based limiting, not a flaw in your design, but worth a comment)

## API surface checks

- [ ] Does `createRateLimiter` throw at construction time for invalid config? (Better than runtime errors)
- [ ] Are sensible defaults in place for all optional fields?
- [ ] Does the middleware return early on OPTIONS preflight? (Or at least allow configuration of which methods to limit)
- [ ] Is the middleware compatible with async error handling? Does it pass errors to `next(err)`?

## Documentation checks

- [ ] Does the README example actually work? (Copy-paste it and run.)
- [ ] Is the `routeCosts` key format documented as `'METHOD /path'` exactly?
- [ ] Are the response headers documented with their exact names?
- [ ] Is the failure behavior (`failOpen`) explicit in the README, not buried?

## Final review prompts

When you're done implementing, ask Claude one of these in a fresh chat:

1. **"Adversarial review"** — "Pretend you're a security researcher who wants to bypass this rate limiter. What attacks do you try?"

2. **"Code review as a senior engineer"** — "Review this as if you're reviewing a PR from a junior. Flag anything you'd block the PR for."

3. **"Production readiness"** — "What's missing for this to run in production at 1000 req/s? Don't list nice-to-haves; list blockers."

The point of three different framings is that each surfaces different issues. Don't ask all three at once or you'll get a wall of generic feedback.
