import express from "express"
import path from "path"
import { fileURLToPath } from "url"
import Redis from "ioredis"
import { inspectIdentifier, listActiveIdentifiers, getLoadMetrics, resetIdentifier } from "../../src/inspection.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT ?? 3001
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-token-change-in-production"

export const redis = new Redis(REDIS_URL, { lazyConnect: true })
export const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, "public")))

function requireAuth(req, res, next) {
  const auth = req.headers.authorization ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" })
  }
  next()
}

app.get("/admin/identifiers", requireAuth, async (req, res) => {
  try {
    const cursor = req.query.cursor ?? "0"
    const filterType = req.query.type ?? undefined
    const result = await listActiveIdentifiers(redis, { cursor, filterType })
    res.json(result)
  } catch (err) {
    console.error("listActiveIdentifiers error:", err)
    res.status(500).json({ error: err.message })
  }
})

app.get("/admin/identifier/:type/:value", requireAuth, async (req, res) => {
  try {
    const { type, value } = req.params
    const result = await inspectIdentifier(redis, type, value)
    if (!result) return res.status(404).json({ error: "Not found" })
    res.json(result)
  } catch (err) {
    console.error("inspectIdentifier error:", err)
    res.status(500).json({ error: err.message })
  }
})

app.delete("/admin/identifier/:type/:value", requireAuth, async (req, res) => {
  try {
    const { type, value } = req.params
    await resetIdentifier(redis, type, value)
    res.json({ ok: true })
  } catch (err) {
    console.error("resetIdentifier error:", err)
    res.status(500).json({ error: err.message })
  }
})

app.get("/admin/load", requireAuth, (_req, res) => {
  res.json(getLoadMetrics())
})

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  app.listen(PORT, () => {
    console.log(`Admin dashboard running at http://localhost:${PORT}`)
    console.log(`Using Redis: ${REDIS_URL}`)
    console.log(`Auth token: ${ADMIN_TOKEN === "dev-token-change-in-production" ? "(default dev token)" : "(custom token set)"}`)
  })
}
