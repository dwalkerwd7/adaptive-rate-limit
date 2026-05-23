import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest'
import { execSync } from 'node:child_process'
import net from 'node:net'
import supertest from 'supertest'
import { app, redis } from '../examples/demo/server.js'

let containerId

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

beforeAll(async () => {
  containerId = execSync('docker run -d -p 6379:6379 redis:latest', { encoding: 'utf8' }).trim()
  await waitForRedis()
}, 60000)

afterAll(async () => {
  await redis.quit()
  if (containerId) execSync(`docker stop ${containerId} && docker rm ${containerId}`)
})

afterEach(async () => {
  await redis.flushall()
})

describe('Demo server endpoints', () => {
  it('GET /api/ping returns 200 with message', async () => {
    const res = await supertest(app).get('/api/ping').expect(200)
    expect(res.body.endpoint).toBe('ping')
    expect(res.body.cost).toBe(1)
  })

  it('GET /api/search returns 200 with results array', async () => {
    const res = await supertest(app).get('/api/search').expect(200)
    expect(res.body.endpoint).toBe('search')
    expect(res.body.cost).toBe(5)
    expect(Array.isArray(res.body.results)).toBe(true)
  })

  it('GET /api/crunch returns 200 with prime count', async () => {
    const res = await supertest(app).get('/api/crunch').expect(200)
    expect(res.body.endpoint).toBe('crunch')
    expect(res.body.cost).toBe(10)
    expect(typeof res.body.primesFound).toBe('number')
    expect(res.body.primesFound).toBeGreaterThan(0)
  })

  it('GET /api/status returns load metrics shape', async () => {
    const res = await supertest(app).get('/api/status').expect(200)
    expect(res.body).toHaveProperty('enabled')
    expect(res.body).toHaveProperty('currentFactor')
    expect(res.body).toHaveProperty('cpuPercent')
  })

  it('rate-limit headers are present on allowed requests', async () => {
    const res = await supertest(app).get('/api/ping').expect(200)
    expect(res.headers['ratelimit-limit']).toBeDefined()
    expect(res.headers['ratelimit-remaining']).toBeDefined()
    expect(res.headers['ratelimit-reset']).toBeDefined()
  })

  it('crunch depletes quota 10× faster than ping', async () => {
    // 1 crunch = cost 10, so 2 crunches exhaust a 20-limit window (all else equal)
    await supertest(app).get('/api/crunch').set('X-Forwarded-For', '1.1.1.1').expect(200)
    const res = await supertest(app).get('/api/crunch').set('X-Forwarded-For', '1.1.1.1').expect(200)
    expect(res.headers['ratelimit-remaining']).toBe('0')
    await supertest(app).get('/api/crunch').set('X-Forwarded-For', '1.1.1.1').expect(429)
  })

  it('ping takes 20 requests to exhaust the window', async () => {
    for (let i = 0; i < 20; i++) {
      await supertest(app).get('/api/ping').set('X-Forwarded-For', '2.2.2.2').expect(200)
    }
    await supertest(app).get('/api/ping').set('X-Forwarded-For', '2.2.2.2').expect(429)
  })

  it('returns 429 with Retry-After when limit exceeded', async () => {
    for (let i = 0; i < 2; i++) {
      await supertest(app).get('/api/crunch').set('X-Forwarded-For', '3.3.3.3')
    }
    const res = await supertest(app).get('/api/crunch').set('X-Forwarded-For', '3.3.3.3').expect(429)
    expect(parseInt(res.headers['retry-after'], 10)).toBeGreaterThan(0)
  })
})
