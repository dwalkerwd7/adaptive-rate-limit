import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

// cost members can't really be generated directly in the lua script due to lua limitations on generating random bytes
function generateCostMembers(cost) {
  let members = []
  for (let i = 0; i < cost; i++) {
    members.push(Date.now.toString() + ":" + crypto.randomBytes(4).toString("hex"))
  }

  return members;
}

export function registerScript(redis) {
  const slidingWindowCheckScript = readFileSync(path.join(__dirname, "sliding-window-check.lua"))

  // KEYS[1] = window key
  // ARGV[1] = now (ms)
  // ARGV[2] = windowMs
  // ARGV[3] = limit
  // ARGV[4] = cost
  // ARGV[5..N] = new entry strings (one per cost unit)
  redis.defineCommand("slidingWindowCheck", {
    numberOfKeys: 1,
    lua: slidingWindowCheckScript
  })
}

// calls once per request in the middleware wrapper
export async function check(redis, key, windowMs, limit, cost) {
  if (cost === 0) {
    const count = await redis.zcard(key)
    return {
      allowed: Number(count <= limit),
      count: count,
      limit: limit,
      resetAt: Date.now() + windowMs
    }
  }

  const [allowed, count, _limit, resetAt] = await redis.slidingWindowCheck(
    key,
    Date.now(),
    windowMs,
    limit,
    cost,
    ...generateCostMembers(cost))

  return {
    allowed: Number(allowed),
    count: Number(count),
    limit: Number(_limit),
    resetAt: Number(resetAt)
  }
}
