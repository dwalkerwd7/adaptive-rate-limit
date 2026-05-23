import { hashValue } from "./utils.js"
import { getInstance } from "./adaptive/load-monitor.js"

export async function inspectIdentifier(redis, type, value, opts = {}) {
  const keyPrefix = opts.keyPrefix ?? "rl"
  const windowMs = opts.windowMs ?? null

  const hashed = hashValue(value)
  const windowKey = `${keyPrefix}:window:${type}:${hashed}`
  const penaltyKey = `${keyPrefix}:penalty:${type}:${hashed}`

  const [count, penaltyRaw, penaltyPttl, oldest] = await Promise.all([
    redis.zcard(windowKey),
    redis.get(penaltyKey),
    redis.pttl(penaltyKey),
    redis.zrange(windowKey, 0, 0, "WITHSCORES")
  ])

  if (count === 0 && penaltyRaw == null) return null

  const oldestScore = oldest[1] ? Number(oldest[1]) : null
  const resetAt = oldestScore && windowMs ? oldestScore + windowMs : null

  return {
    type,
    value,
    currentCount: count,
    windowMs,
    resetAt,
    penaltyMultiplier: penaltyRaw ? parseFloat(penaltyRaw) : 1.0,
    penaltyExpiresAt: penaltyPttl > 0 ? Date.now() + penaltyPttl : null
  }
}

export async function listActiveIdentifiers(redis, opts = {}) {
  const keyPrefix = opts.keyPrefix ?? "rl"
  const cursor = opts.cursor ?? "0"
  const count = opts.count ?? 100
  const filterType = opts.filterType

  const pattern = filterType
    ? `${keyPrefix}:window:${filterType}:*`
    : `${keyPrefix}:window:*`

  const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", count)

  const windowPrefix = `${keyPrefix}:window:`
  const identifiers = await Promise.all(keys.map(async key => {
    const rest = key.slice(windowPrefix.length)
    const colonIdx = rest.indexOf(":")
    const type = rest.slice(0, colonIdx)
    const valueHash = rest.slice(colonIdx + 1)

    const penaltyKey = `${keyPrefix}:penalty:${type}:${valueHash}`
    const [currentCount, penaltyRaw] = await Promise.all([
      redis.zcard(key),
      redis.get(penaltyKey)
    ])

    return {
      type,
      valueHash,
      currentCount,
      penaltyMultiplier: penaltyRaw ? parseFloat(penaltyRaw) : 1.0
    }
  }))

  return { cursor: nextCursor, identifiers }
}

export function getLoadMetrics() {
  const monitor = getInstance()
  if (monitor) return monitor.getMetrics()
  return { enabled: false, currentFactor: 1.0, cpuPercent: 0, lastSampleAt: 0, cpuThreshold: 70 }
}

export async function resetIdentifier(redis, type, value, opts = {}) {
  const keyPrefix = opts.keyPrefix ?? "rl"
  const hashed = hashValue(value)
  const windowKey = `${keyPrefix}:window:${type}:${hashed}`
  const penaltyKey = `${keyPrefix}:penalty:${type}:${hashed}`
  await redis.del(windowKey, penaltyKey)
}
