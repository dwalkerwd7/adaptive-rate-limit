import express from "express"
import { fileURLToPath } from "url"
import Redis from "ioredis"
import createRateLimiter from "../../src/middleware.js"
import { getLoadMetrics } from "../../src/inspection.js"

const PORT = process.env.PORT ?? 5003
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

const redis = new Redis(REDIS_URL)
redis.on("error", err => console.error("[demo] Redis:", err.message))

const app = express()
app.set("trust proxy", 2)
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))))

const limiter = createRateLimiter({
  redis,
  windowMs: 10_000,
  limit: 20,
  identifiers: ["ip", "sessionId"],
  routeCosts: {
    "GET /api/ping": 1,
    "GET /api/search": 5,
    "GET /api/crunch": 10,
  },
  adaptive: {
    enabled: true,
    cpuThreshold: 15,
    minFactor: 0.3,
    pollIntervalMs: 1000,
  },
})

app.get("/api/status", (_req, res) => {
  res.json(getLoadMetrics())
})

app.use(limiter)

app.get("/api/ping", (_req, res) => {
  res.json({ endpoint: "ping", cost: 1, message: "pong" })
})

app.get("/api/search", (_req, res) => {
  // simulate a short DB-like delay
  const results = Array.from({ length: 20 }, (_, i) => ({ id: i, value: Math.random() }))
  res.json({ endpoint: "search", cost: 5, results })
})

app.get("/api/crunch", (_req, res) => {
  // synchronous CPU work so the load monitor reacts
  let count = 0
  for (let n = 2; n < 500_000; n++) {
    let prime = true
    for (let d = 2; d <= Math.sqrt(n); d++) {
      if (n % d === 0) { prime = false; break }
    }
    if (prime) count++
  }
  res.json({ endpoint: "crunch", cost: 10, primesFound: count })
})

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  app.listen(PORT, () => {
    console.log(`Demo running on port ${PORT}...`)
    console.log(`Redis: ${REDIS_URL}`)
  })
}

export { app, redis }
