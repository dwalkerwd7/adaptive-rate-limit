import { argv0 } from "node:process"
import redis from "../redis/client"
import crypto from "node:crypto"

// cost members can't really be generated directly in the lua script due to lua limitations on generating random bytes
function generateCostMembers(cost) {
  let members = []
  for (let i = 0; i < cost; i++) {
    members.push(Date.now.toString() + ":" + crypto.randomBytes(4).toString("hex"))
  }

  return members;
}

// calls once per request in the middleware wrapper
export default async function check(redis, key, windowMs, limit, cost) {
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
