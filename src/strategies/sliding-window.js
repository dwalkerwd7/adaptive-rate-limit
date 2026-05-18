import redis from "../redis/client"
import crypto from "node:crypto"

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

  const [allowed, count, _limit, resetAt] = await redis.slidingWindowCheck(key, Date.now(), windowMs, limit, cost, Date.now.toString() + ":" + crypto.randomBytes(4).toString("hex"))

  return {
    allowed: Number(allowed),
    count: Number(count),
    limit: Number(_limit),
    resetAt: Number(resetAt)
  }
}
