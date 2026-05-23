import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest'
import { execSync } from 'node:child_process'
import net from 'node:net'
import Redis from 'ioredis'
import express from 'express'
import supertest from 'supertest'
import createRateLimiter from '../src/middleware.js'

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

// ─── Task 1.2: Sliding Window ────────────────────────────────────────────────

describe('Task 1.2 — Sliding Window', () => {
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

// ─── Task 1.3: Identifier Chaining ──────────────────────────────────────────

describe('Task 1.3 — Identifier Chaining', () => {
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

// ─── Task 1.4: Per-Route Cost Weights ────────────────────────────────────────

describe('Task 1.4 — Per-Route Cost Weights', () => {
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

// ─── Task 2.2: Penalty Scorer ────────────────────────────────────────────────

describe('Task 2.2 — Penalty Scorer', () => {
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
