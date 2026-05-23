import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest'
import { execSync } from 'node:child_process'
import net from 'node:net'
import Redis from 'ioredis'
import express from 'express'
import supertest from 'supertest'
import createRateLimiter from '../src/middleware.js'
import { inspectIdentifier, listActiveIdentifiers, getLoadMetrics, resetIdentifier } from '../src/inspection.js'
import { resetMonitor } from '../src/adaptive/load-monitor.js'

let containerId
let redis

async function waitForRedis(host = '127.0.0.1', port = 6379, maxWaitMs = 15000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, host)
        socket.on('connect', () => { socket.destroy(); resolve() })
        socket.on('error', reject)
        socket.setTimeout(500, () => { socket.destroy(); reject(new Error('timeout')) })
      })
      return
    } catch {
      await new Promise(r => setTimeout(r, 250))
    }
  }
  throw new Error(`Redis at ${host}:${port} did not become available within ${maxWaitMs}ms`)
}

function createApp(limiterOpts, extraMiddleware = []) {
  const app = express()
  app.set('trust proxy', 1)
  for (const mw of extraMiddleware) app.use(mw)
  app.use(createRateLimiter({ redis, ...limiterOpts }))
  app.get('/test', (_req, res) => res.json({ ok: true }))
  app.post('/test', (_req, res) => res.json({ ok: true }))
  app.get('/heavy', (_req, res) => res.json({ ok: true }))
  return app
}

function userMiddleware(req, _res, next) {
  const userId = req.headers['x-user-id']
  if (userId) req.user = { id: userId }
  next()
}

beforeAll(async () => {
  containerId = execSync('docker run -d -p 6379:6379 redis:latest', { encoding: 'utf8' }).trim()
  await waitForRedis()
  redis = new Redis({ host: '127.0.0.1', port: 6379 })
}, 60000)

afterAll(async () => {
  if (redis) await redis.quit()
  if (containerId) {
    execSync(`docker stop ${containerId} && docker rm ${containerId}`)
  }
})

beforeEach(async () => {
  await redis.flushall()
})

describe('Sliding Window', () => {
  it('allows exactly N requests within a window, blocks the N+1th', async () => {
    const app = createApp({ windowMs: 5000, limit: 5 })
    for (let i = 0; i < 5; i++) {
      await supertest(app).get('/test').expect(200)
    }
    await supertest(app).get('/test').expect(429)
  })

  it('sets correct standard rate-limit headers on allowed requests', async () => {
    const app = createApp({ windowMs: 5000, limit: 10 })
    const res = await supertest(app).get('/test').expect(200)
    expect(res.headers['ratelimit-limit']).toBe('10')
    expect(res.headers['ratelimit-remaining']).toBe('9')
    expect(res.headers['ratelimit-policy']).toBe('10;w=5')
    expect(res.headers['ratelimit-reset']).toBeDefined()
  })

  it('decrements ratelimit-remaining with each successive request', async () => {
    const app = createApp({ windowMs: 5000, limit: 5 })
    for (let expected = 4; expected >= 0; expected--) {
      const res = await supertest(app).get('/test').expect(200)
      expect(res.headers['ratelimit-remaining']).toBe(String(expected))
    }
  })

  it('returns 429 with Retry-After and ratelimit-remaining=0 when limit exceeded', async () => {
    const app = createApp({ windowMs: 5000, limit: 1 })
    await supertest(app).get('/test').expect(200)
    const res = await supertest(app).get('/test').expect(429)
    expect(parseInt(res.headers['retry-after'], 10)).toBeGreaterThan(0)
    expect(res.headers['ratelimit-remaining']).toBe('0')
  })

  it('allows requests again after the window expires', async () => {
    const app = createApp({ windowMs: 1000, limit: 2 })
    await supertest(app).get('/test').expect(200)
    await supertest(app).get('/test').expect(200)
    await supertest(app).get('/test').expect(429)
    await new Promise(r => setTimeout(r, 1100))
    await supertest(app).get('/test').expect(200)
  })

  it('uses legacy X-RateLimit-* headers when standardHeaders is false', async () => {
    const app = createApp({ windowMs: 5000, limit: 10, standardHeaders: false })
    const res = await supertest(app).get('/test').expect(200)
    expect(res.headers['x-ratelimit-limit']).toBe('10')
    expect(res.headers['x-ratelimit-remaining']).toBe('9')
    expect(res.headers['ratelimit-limit']).toBeUndefined()
  })

  it('fails open when Redis is unavailable and failOpen is true', async () => {
    const brokenRedis = new Redis({
      host: '127.0.0.1',
      port: 19999, // nothing listening here
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      lazyConnect: true
    })
    const app = express()
    app.use(createRateLimiter({ redis: brokenRedis, windowMs: 5000, limit: 1, failOpen: true }))
    app.get('/test', (_req, res) => res.json({ ok: true }))

    const res = await supertest(app).get('/test').expect(200)
    expect(res.headers['ratelimit-status']).toBe('degraded')
    brokenRedis.disconnect()
  })
})

describe('Identifier Chaining', () => {
  it('blocks a user who hit their limit even when they switch to a fresh IP', async () => {
    const app = createApp(
      { windowMs: 5000, limit: 3, identifiers: ['ip', 'userId'] },
      [userMiddleware]
    )
    // exhaust user "alice" from one IP
    for (let i = 0; i < 3; i++) {
      await supertest(app).get('/test')
        .set('X-Forwarded-For', '1.2.3.4')
        .set('x-user-id', 'alice')
        .expect(200)
    }
    // same user, completely fresh IP → blocked because the user window is full
    await supertest(app).get('/test')
      .set('X-Forwarded-For', '9.9.9.9')
      .set('x-user-id', 'alice')
      .expect(429)
  })

  it('tracks different users on the same IP independently', async () => {
    const app = createApp(
      { windowMs: 5000, limit: 2, identifiers: ['userId'] },
      [userMiddleware]
    )
    await supertest(app).get('/test').set('x-user-id', 'alice').expect(200)
    await supertest(app).get('/test').set('x-user-id', 'alice').expect(200)
    await supertest(app).get('/test').set('x-user-id', 'alice').expect(429)
    // bob has a separate window — full limit available
    await supertest(app).get('/test').set('x-user-id', 'bob').expect(200)
    await supertest(app).get('/test').set('x-user-id', 'bob').expect(200)
  })

  it('skips an identifier whose extractor returns null (no req.user set)', async () => {
    const app = createApp({ windowMs: 5000, limit: 2, identifiers: ['userId'] })
    // userId extractor returns undefined when req.user is absent → identifier skipped
    for (let i = 0; i < 5; i++) {
      await supertest(app).get('/test').expect(200)
    }
  })

  it('uses the tightest identifier to set response headers', async () => {
    const app = createApp(
      { windowMs: 5000, limit: 5, identifiers: ['ip', 'userId'] },
      [userMiddleware]
    )
    // consume 4 user-window slots
    for (let i = 0; i < 4; i++) {
      await supertest(app).get('/test')
        .set('X-Forwarded-For', '1.1.1.1')
        .set('x-user-id', 'carol')
    }
    // next request: user has 1 left, IP has 1 left (same count here, tightest picks highest count)
    const res = await supertest(app).get('/test')
      .set('X-Forwarded-For', '1.1.1.1')
      .set('x-user-id', 'carol')
      .expect(200)
    expect(res.headers['ratelimit-remaining']).toBe('0')
  })
})

describe('Per-Route Cost Weights', () => {
  it('high-cost route exhausts the limit in fewer requests', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 10,
      routeCosts: { 'GET /heavy': 5 }
    })
    await supertest(app).get('/heavy').expect(200) // cost 5 → remaining 5
    await supertest(app).get('/heavy').expect(200) // cost 5 → remaining 0
    await supertest(app).get('/heavy').expect(429) // limit exhausted
  })

  it('low-cost route needs many more requests to hit the limit', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 5,
      routeCosts: { 'GET /test': 1 }
    })
    for (let i = 0; i < 5; i++) {
      await supertest(app).get('/test').expect(200)
    }
    await supertest(app).get('/test').expect(429)
  })

  it('falls back to routeCosts.default when route is not explicitly listed', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 4,
      routeCosts: { default: 2 }
    })
    await supertest(app).get('/test').expect(200) // cost 2 → count 2
    await supertest(app).get('/test').expect(200) // cost 2 → count 4
    await supertest(app).get('/test').expect(429) // count 4 + 2 > 4
  })

  it('costResolver function takes precedence over routeCosts', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 10,
      costResolver: req => parseInt(req.headers['x-cost'] || '1', 10)
    })
    await supertest(app).get('/test').set('x-cost', '5').expect(200) // count 5
    await supertest(app).get('/test').set('x-cost', '5').expect(200) // count 10
    await supertest(app).get('/test').set('x-cost', '1').expect(429) // count 10 + 1 > 10
  })

  it('cost 0 performs a read-only check without consuming quota', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      routeCosts: { 'GET /test': 0 }
    })
    // cost 0 → nothing written to sorted set → never blocked
    for (let i = 0; i < 6; i++) {
      await supertest(app).get('/test').expect(200)
    }
  })

  it('high-cost and low-cost routes share the same window counter', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 10,
      routeCosts: { 'GET /heavy': 5, 'GET /test': 1 }
    })
    await supertest(app).get('/heavy').expect(200) // count 5
    await supertest(app).get('/heavy').expect(200) // count 10
    // cheap route still blocked because window is full
    await supertest(app).get('/test').expect(429)
  })
})

describe('Penalty Scorer', () => {
  it('writes a penalty key to Redis after a violation, defaulting multiplier to 1.0 + increment', async () => {
    const INCREMENT = 0.5
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: INCREMENT, maxMultiplier: 4.0, decayMs: 60000 }
    })
    const ip = '10.0.0.1'
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)
    await new Promise(r => setTimeout(r, 150)) // let fire-and-forget write settle

    const keys = await redis.keys('rl:penalty:ip:*')
    expect(keys.length).toBe(1)
    expect(parseFloat(await redis.get(keys[0]))).toBeCloseTo(1.0 + INCREMENT, 5)
  })

  it('penalty reduces the effective limit in the next window', async () => {
    const LIMIT = 10
    const INCREMENT = 1.0
    const app = createApp({
      windowMs: 1000,
      limit: LIMIT,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: INCREMENT, maxMultiplier: 4.0, decayMs: 60000 }
    })
    const ip = '10.0.0.2'

    // fill window and trigger penalty (multiplier → 1.0 + 1.0 = 2.0)
    for (let i = 0; i < LIMIT; i++) {
      await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    }
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)
    await new Promise(r => setTimeout(r, 150))

    // wait for window to reset
    await new Promise(r => setTimeout(r, 1100))

    // effective limit is now floor(10 / 2.0) = 5
    let allowedCount = 0
    for (let i = 0; i < LIMIT; i++) {
      const res = await supertest(app).get('/test').set('X-Forwarded-For', ip)
      if (res.status === 200) allowedCount++
      else break
    }
    expect(allowedCount).toBe(Math.floor(LIMIT / (1.0 + INCREMENT)))
  })

  it('caps the penalty multiplier at maxMultiplier regardless of violation count', async () => {
    const MAX_MULT = 2.0
    // increment > maxMultiplier so the cap is hit on the very first violation
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 10.0, maxMultiplier: MAX_MULT, decayMs: 60000 }
    })
    const ip = '10.0.0.3'

    // trigger several violations
    for (let v = 0; v < 4; v++) {
      await supertest(app).get('/test').set('X-Forwarded-For', ip)
    }
    await new Promise(r => setTimeout(r, 150))

    const keys = await redis.keys('rl:penalty:ip:*')
    expect(keys.length).toBe(1)
    expect(parseFloat(await redis.get(keys[0]))).toBe(MAX_MULT)
  })

  it('penalty key expires after decayMs with no further violations', async () => {
    const DECAY_MS = 400
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 0.5, maxMultiplier: 4.0, decayMs: DECAY_MS }
    })
    const ip = '10.0.0.4'

    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)
    await new Promise(r => setTimeout(r, 150))

    expect((await redis.keys('rl:penalty:ip:*')).length).toBe(1)

    // wait for the TTL to expire
    await new Promise(r => setTimeout(r, DECAY_MS + 150))

    expect((await redis.keys('rl:penalty:ip:*')).length).toBe(0)
  })

  it('penalty resets TTL on each subsequent violation (decay from last violation)', async () => {
    const DECAY_MS = 400
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 0.5, maxMultiplier: 4.0, decayMs: DECAY_MS }
    })
    const ip = '10.0.0.5'

    // first violation
    for (let i = 0; i < 3; i++) {
      await supertest(app).get('/test').set('X-Forwarded-For', ip)
    }
    await new Promise(r => setTimeout(r, 150))

    // wait half the decay window, then trigger another violation to reset TTL
    await new Promise(r => setTimeout(r, DECAY_MS / 2))
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)
    await new Promise(r => setTimeout(r, 150))

    // wait the rest of the original decay window — key should still be alive
    await new Promise(r => setTimeout(r, DECAY_MS / 2))
    expect((await redis.keys('rl:penalty:ip:*')).length).toBe(1)
  })

  it('429 response is not held up by fire-and-forget penalty recording', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 1,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 0.5, maxMultiplier: 4.0, decayMs: 60000 }
    })
    const ip = '10.0.0.6'
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)

    const start = Date.now()
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('penalty is scoped per identifier — other identifiers are unaffected', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 1.0, maxMultiplier: 4.0, decayMs: 60000 }
    })
    // penalize 10.0.1.1
    for (let i = 0; i < 3; i++) {
      await supertest(app).get('/test').set('X-Forwarded-For', '10.0.1.1')
    }
    await new Promise(r => setTimeout(r, 150))

    // 10.0.2.2 has a clean slate — full limit applies
    await supertest(app).get('/test').set('X-Forwarded-For', '10.0.2.2').expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', '10.0.2.2').expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', '10.0.2.2').expect(429)
  })

  it('multiple blocked identifiers each receive their own penalty', async () => {
    const app = createApp(
      {
        windowMs: 5000,
        limit: 2,
        identifiers: ['ip', 'userId'],
        penalty: { incrementPerViolation: 0.5, maxMultiplier: 4.0, decayMs: 60000 }
      },
      [userMiddleware]
    )
    const ip = '10.0.3.1'
    const user = 'dave'

    // fill window for both ip and user simultaneously
    for (let i = 0; i < 2; i++) {
      await supertest(app).get('/test')
        .set('X-Forwarded-For', ip)
        .set('x-user-id', user)
        .expect(200)
    }
    // trigger violation for both
    await supertest(app).get('/test')
      .set('X-Forwarded-For', ip)
      .set('x-user-id', user)
      .expect(429)
    await new Promise(r => setTimeout(r, 150))

    // both an ip and a userId penalty key should exist
    const ipKeys = await redis.keys('rl:penalty:ip:*')
    const userKeys = await redis.keys('rl:penalty:userId:*')
    expect(ipKeys.length).toBe(1)
    expect(userKeys.length).toBe(1)
  })
})

// ─── Inspection Helpers (Task 2.3) ───────────────────────────────────────────

describe('Inspection Helpers', () => {
  it('inspectIdentifier returns null when the identifier has no state', async () => {
    const state = await inspectIdentifier(redis, 'ip', '0.0.0.0', { keyPrefix: 'rl', windowMs: 5000 })
    expect(state).toBeNull()
  })

  it('inspectIdentifier returns current window count after requests', async () => {
    const WINDOW_MS = 5000
    const app = createApp({ windowMs: WINDOW_MS, limit: 10, identifiers: ['ip'] })
    const ip = '30.0.0.1'

    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)

    const state = await inspectIdentifier(redis, 'ip', ip, { keyPrefix: 'rl', windowMs: WINDOW_MS })

    expect(state).not.toBeNull()
    expect(state.type).toBe('ip')
    expect(state.value).toBe(ip)
    expect(state.currentCount).toBe(3)
    expect(state.windowMs).toBe(WINDOW_MS)
    expect(state.resetAt).toBeGreaterThan(Date.now())
    expect(state.penaltyMultiplier).toBe(1.0)
    expect(state.penaltyExpiresAt).toBeNull()
  })

  it('inspectIdentifier reflects penalty multiplier and expiry', async () => {
    const DECAY_MS = 60000
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 0.5, maxMultiplier: 4.0, decayMs: DECAY_MS }
    })
    const ip = '30.0.0.2'

    for (let i = 0; i < 3; i++) {
      await supertest(app).get('/test').set('X-Forwarded-For', ip)
    }
    await new Promise(r => setTimeout(r, 150))

    const state = await inspectIdentifier(redis, 'ip', ip, { keyPrefix: 'rl', windowMs: 5000 })

    expect(state.penaltyMultiplier).toBeCloseTo(1.5, 5)
    expect(state.penaltyExpiresAt).toBeGreaterThan(Date.now())
  })

  it('listActiveIdentifiers returns a summary for each active window key', async () => {
    const app = createApp({ windowMs: 5000, limit: 10, identifiers: ['ip'] })

    await supertest(app).get('/test').set('X-Forwarded-For', '31.0.0.1').expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', '31.0.0.2').expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', '31.0.0.2').expect(200)

    const { cursor, identifiers } = await listActiveIdentifiers(redis, { keyPrefix: 'rl' })

    expect(identifiers.length).toBe(2)
    expect(identifiers.every(id => id.type === 'ip')).toBe(true)
    expect(identifiers.every(id => typeof id.valueHash === 'string')).toBe(true)
    expect(identifiers.every(id => id.penaltyMultiplier === 1.0)).toBe(true)
    const counts = identifiers.map(id => id.currentCount).sort()
    expect(counts).toEqual([1, 2])
    expect(typeof cursor).toBe('string')
  })

  it('listActiveIdentifiers filterType narrows results to one identifier type', async () => {
    const app = createApp(
      { windowMs: 5000, limit: 10, identifiers: ['ip', 'userId'] },
      [userMiddleware]
    )
    await supertest(app).get('/test')
      .set('X-Forwarded-For', '32.0.0.1')
      .set('x-user-id', 'eve')
      .expect(200)

    const ipResult = await listActiveIdentifiers(redis, { keyPrefix: 'rl', filterType: 'ip' })
    const userResult = await listActiveIdentifiers(redis, { keyPrefix: 'rl', filterType: 'userId' })

    expect(ipResult.identifiers.every(id => id.type === 'ip')).toBe(true)
    expect(userResult.identifiers.every(id => id.type === 'userId')).toBe(true)
    expect(ipResult.identifiers.length).toBeGreaterThanOrEqual(1)
    expect(userResult.identifiers.length).toBeGreaterThanOrEqual(1)
  })

  it('resetIdentifier clears both window and penalty keys', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 0.5, maxMultiplier: 4.0, decayMs: 60000 }
    })
    const ip = '33.0.0.1'

    for (let i = 0; i < 3; i++) {
      await supertest(app).get('/test').set('X-Forwarded-For', ip)
    }
    await new Promise(r => setTimeout(r, 150))

    expect((await redis.keys('rl:window:ip:*')).length).toBe(1)
    expect((await redis.keys('rl:penalty:ip:*')).length).toBe(1)

    await resetIdentifier(redis, 'ip', ip)

    expect((await redis.keys('rl:window:ip:*')).length).toBe(0)
    expect((await redis.keys('rl:penalty:ip:*')).length).toBe(0)
  })

  it('resetIdentifier allows the identifier to start fresh after being cleared', async () => {
    const LIMIT = 2
    const app = createApp({ windowMs: 5000, limit: LIMIT, identifiers: ['ip'] })
    const ip = '33.0.0.2'

    // exhaust the limit
    for (let i = 0; i < LIMIT; i++) {
      await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    }
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)

    await resetIdentifier(redis, 'ip', ip)

    // full limit available again
    for (let i = 0; i < LIMIT; i++) {
      await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    }
  })
})

// ─── Callbacks (Task 2.3) ────────────────────────────────────────────────────

describe('Callbacks', () => {
  it('onViolation fires with correct info when penalty multiplier increases', async () => {
    let violationInfo = null
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 0.5, maxMultiplier: 4.0, decayMs: 60000 },
      onViolation: (_req, info) => { violationInfo = info }
    })
    const ip = '40.0.0.1'

    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)
    await new Promise(r => setTimeout(r, 150))

    expect(violationInfo).not.toBeNull()
    expect(violationInfo.identifier.type).toBe('ip')
    expect(violationInfo.previousMultiplier).toBe(1.0)
    expect(violationInfo.newMultiplier).toBeCloseTo(1.5, 5)
    expect(violationInfo.decayMs).toBe(60000)
  })

  it('onViolation does not fire when multiplier is already at max', async () => {
    let callCount = 0
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 10.0, maxMultiplier: 2.0, decayMs: 60000 },
      onViolation: () => { callCount++ }
    })
    const ip = '40.0.0.2'

    // first violation: 1.0 → 2.0 (capped) — fires onViolation
    for (let i = 0; i < 3; i++) await supertest(app).get('/test').set('X-Forwarded-For', ip)
    await new Promise(r => setTimeout(r, 150))
    expect(callCount).toBe(1)

    // subsequent violations: 2.0 → 2.0 (no change) — does NOT fire
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)
    await new Promise(r => setTimeout(r, 150))
    expect(callCount).toBe(1)
  })

  it('a throwing onViolation callback does not crash the middleware', async () => {
    const app = createApp({
      windowMs: 5000,
      limit: 1,
      identifiers: ['ip'],
      penalty: { incrementPerViolation: 0.5, maxMultiplier: 4.0, decayMs: 60000 },
      onViolation: () => { throw new Error('callback boom') }
    })
    await supertest(app).get('/test').set('X-Forwarded-For', '40.0.0.3').expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', '40.0.0.3').expect(429)
    await new Promise(r => setTimeout(r, 150))
    // different IP — middleware is still healthy
    await supertest(app).get('/test').set('X-Forwarded-For', '40.0.0.4').expect(200)
  })

  it('onAllowed fires for each allowed request with the correct info shape', async () => {
    let callCount = 0
    let lastInfo = null
    const app = createApp({
      windowMs: 5000,
      limit: 10,
      identifiers: ['ip'],
      onAllowed: (_req, info) => { callCount++; lastInfo = info }
    })
    const ip = '40.0.1.1'

    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)

    expect(callCount).toBe(2)
    expect(lastInfo.allowed).toBe(true)
    expect(lastInfo.baseLimit).toBe(10)
    expect(lastInfo.current).toBe(2)
    expect(lastInfo.cost).toBe(1)
    expect(lastInfo.windowMs).toBe(5000)
    expect(lastInfo.adaptiveFactor).toBe(1.0)
    expect(lastInfo.penaltyMultiplier).toBe(1.0)
    expect(lastInfo.resetAt).toBeGreaterThan(Date.now())
    expect(lastInfo.identifier.type).toBe('ip')
  })

  it('onAllowed does not fire for blocked requests', async () => {
    let callCount = 0
    const app = createApp({
      windowMs: 5000,
      limit: 2,
      identifiers: ['ip'],
      onAllowed: () => { callCount++ }
    })
    const ip = '40.0.1.2'

    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(200)
    await supertest(app).get('/test').set('X-Forwarded-For', ip).expect(429)

    expect(callCount).toBe(2)
  })

  it('onDegraded fires with the Redis error when failing open', async () => {
    let degradedError = null
    const brokenRedis = new Redis({
      host: '127.0.0.1', port: 19999,
      maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true
    })
    const app = express()
    app.use(createRateLimiter({
      redis: brokenRedis, windowMs: 5000, limit: 10,
      failOpen: true,
      onDegraded: (_req, err) => { degradedError = err }
    }))
    app.get('/test', (_req, res) => res.json({ ok: true }))

    await supertest(app).get('/test').expect(200)

    expect(degradedError).toBeInstanceOf(Error)
    brokenRedis.disconnect()
  })

  it('a throwing onDegraded callback does not crash the middleware', async () => {
    const brokenRedis = new Redis({
      host: '127.0.0.1', port: 19999,
      maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true
    })
    const app = express()
    app.use(createRateLimiter({
      redis: brokenRedis, windowMs: 5000, limit: 10,
      failOpen: true,
      onDegraded: () => { throw new Error('callback boom') }
    }))
    app.get('/test', (_req, res) => res.json({ ok: true }))

    await supertest(app).get('/test').expect(200)
    brokenRedis.disconnect()
  })
})

// ─── Adaptive Load Monitor (Task 2.1) ────────────────────────────────────────

describe('Adaptive Load Monitor', () => {
  afterEach(() => resetMonitor())

  it('getLoadMetrics returns disabled stub before any adaptive middleware is created', () => {
    const metrics = getLoadMetrics()
    expect(metrics).toEqual({ enabled: false, currentFactor: 1.0, cpuPercent: 0, lastSampleAt: 0, cpuThreshold: 70 })
  })

  it('starts the monitor and returns live metrics when adaptive.enabled is true', () => {
    createApp({ windowMs: 5000, limit: 10, adaptive: { enabled: true, cpuThreshold: 80 } })
    const metrics = getLoadMetrics()
    expect(metrics.enabled).toBe(true)
    expect(metrics.cpuThreshold).toBe(80)
    expect(metrics.currentFactor).toBeGreaterThanOrEqual(0.3)
    expect(metrics.currentFactor).toBeLessThanOrEqual(1.0)
    expect(typeof metrics.cpuPercent).toBe('number')
    expect(typeof metrics.lastSampleAt).toBe('number')
  })

  it('a second adaptive middleware reuses the existing monitor (singleton)', () => {
    createApp({ windowMs: 5000, limit: 10, adaptive: { enabled: true, cpuThreshold: 65 } })
    createApp({ windowMs: 5000, limit: 10, adaptive: { enabled: true, cpuThreshold: 90 } })
    // first caller's options win — cpuThreshold 90 from the second call is ignored
    expect(getLoadMetrics().cpuThreshold).toBe(65)
  })

  it('onAllowed info includes the adaptive factor from the monitor', async () => {
    let capturedFactor = null
    const app = createApp({
      windowMs: 5000,
      limit: 10,
      adaptive: { enabled: true },
      onAllowed: (_req, info) => { capturedFactor = info.adaptiveFactor }
    })
    await supertest(app).get('/test').expect(200)
    expect(typeof capturedFactor).toBe('number')
    expect(capturedFactor).toBeGreaterThan(0)
    expect(capturedFactor).toBeLessThanOrEqual(1.0)
  })

  it('adaptive does not break normal request flow', async () => {
    const app = createApp({ windowMs: 5000, limit: 10, adaptive: { enabled: true } })
    // At idle CPU the factor is 1.0, so full limit applies.
    // Use a conservative count so the test passes even under mild CI load.
    for (let i = 0; i < 5; i++) {
      await supertest(app).get('/test').expect(200)
    }
  })
})
