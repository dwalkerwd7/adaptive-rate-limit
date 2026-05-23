import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest'
import { execSync } from 'node:child_process'
import net from 'node:net'
import Redis from 'ioredis'
import express from 'express'
import supertest from 'supertest'
import createRateLimiter from '../src/middleware.js'
import { app as adminApp, redis as adminRedis, ADMIN_TOKEN } from '../examples/admin-dashboard/server.js'

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

function createApp(limiterOpts) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(createRateLimiter({ redis, ...limiterOpts }))
  app.get('/test', (_req, res) => res.json({ ok: true }))
  return app
}

beforeAll(async () => {
  containerId = execSync('docker run -d -p 6379:6379 redis:latest', { encoding: 'utf8' }).trim()
  await waitForRedis()
  redis = new Redis({ host: '127.0.0.1', port: 6379 })
}, 60000)

afterAll(async () => {
  await adminRedis.quit()
  if (redis) await redis.quit()
  if (containerId) {
    execSync(`docker stop ${containerId} && docker rm ${containerId}`)
  }
})

afterEach(async () => {
  await redis.flushall()
})

describe('Admin Dashboard Server', () => {
  const AUTH = `Bearer ${ADMIN_TOKEN}`

  it('rejects requests without a valid bearer token', async () => {
    await supertest(adminApp).get('/admin/identifiers').expect(401)
    await supertest(adminApp).get('/admin/identifiers').set('Authorization', 'Bearer wrong').expect(401)
  })

  it('GET /admin/identifiers returns cursor and identifiers array', async () => {
    const res = await supertest(adminApp).get('/admin/identifiers').set('Authorization', AUTH).expect(200)
    expect(res.body).toHaveProperty('cursor')
    expect(Array.isArray(res.body.identifiers)).toBe(true)
  })

  it('GET /admin/identifier/:type/:value returns 404 for unknown identifier', async () => {
    await supertest(adminApp).get('/admin/identifier/ip/1.2.3.4').set('Authorization', AUTH).expect(404)
  })

  it('GET /admin/identifier/:type/:value returns state for a known identifier', async () => {
    const rlApp = createApp({ windowMs: 5000, limit: 10 })
    await supertest(rlApp).get('/test').set('X-Forwarded-For', '5.5.5.5').expect(200)
    const res = await supertest(adminApp).get('/admin/identifier/ip/5.5.5.5').set('Authorization', AUTH).expect(200)
    expect(res.body.type).toBe('ip')
    expect(res.body.currentCount).toBeGreaterThan(0)
  })

  it('DELETE /admin/identifier/:type/:value resets state and returns ok', async () => {
    const rlApp = createApp({ windowMs: 5000, limit: 10 })
    await supertest(rlApp).get('/test').set('X-Forwarded-For', '6.6.6.6').expect(200)
    await supertest(adminApp).delete('/admin/identifier/ip/6.6.6.6').set('Authorization', AUTH).expect(200)
    const res = await supertest(adminApp).get('/admin/identifier/ip/6.6.6.6').set('Authorization', AUTH).expect(404)
    expect(res.body.error).toBe('Not found')
  })

  it('GET /admin/load returns load metrics shape', async () => {
    const res = await supertest(adminApp).get('/admin/load').set('Authorization', AUTH).expect(200)
    expect(res.body).toHaveProperty('enabled')
    expect(res.body).toHaveProperty('currentFactor')
    expect(res.body).toHaveProperty('cpuPercent')
  })
})
