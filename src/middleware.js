import Redis from "ioredis"
import crypto from "node:crypto"
import createClient from "./redis/client"
import * as sw from "./strategies/sliding-window"
import * as sc from "./penalty/scorer.js"
import resolveIdentifiers from "./indentifiers/chain"

function resolveCost(req, options) {
  if (options.costResolver) return options.costResolver(req)
  if (options.routeCosts) {
    const key = req.method.toUpperCase() + " " + req.path
    if (key in options.routeCosts) return options.routeCosts[key]
    if ("default" in options.routeCosts) return options.routeCosts.default
  }
  return 1
}

export const createRateLimiter = (options) => {
  if (!options.redis) throw Error("[ARL]: redis options or instance not provided")
  if (typeof options.redis !== "object" && !(options.redis instanceof Redis)) throw TypeError("type of redis provided is not correct")
  if (!options?.windowMs) throw Error("[ARL]: windowMs option required")
  if (options.windowMs < 1000) throw Error("[ARL]: windowMs must be >= 1000")
  if (!options?.limit) throw Error("[ARL]: limit option required")

  let redisClient = null

  if (!(options.redis instanceof Redis)) {
    try {
      if (!options?.redis.host || !options?.redis.port) throw TypeError("[ARL]: redis options need to include at least a host and a port")
      redisClient = createClient(options.redis)
    } catch (error) {
      throw Error("[ARL]: could not create redis client with the options provided")
    }
  } else {
    redisClient = options.redis
  }

  try {
    sw.registerScript(redisClient)
    sc.registerScript(redisClient)
  } catch (error) {
    throw Error("[ARL]: could not register redis commands")
  }

  if (!options?.keyPrefix)
    options.keyPrefix = "rl"

  return async (req, res, next) => {
    const identifiers = resolveIdentifiers(req, options)
    const cost = resolveCost(req, options)

    let keys = []
    let promises = []

    for (const i of identifiers) {
      const value = i.extractor(req)
      if (value == null) continue
      const hashed = crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32)
      const key = options.keyPrefix + ":window:" + i.type + ":" + hashed
      keys.push(key)
      promises.push(sw.check(redisClient, key, options.windowMs, options.limit, cost))
    }

    try {
      const results = await Promise.all(promises)
      let tightest_res = {
        allowed: 1,
        count: -Infinity,
        limit: Infinity,
        resetAt: Infinity
      }

      let tightest_key_idx = -1
      let i = 0
      for (const r of results) {
        if (r.count > tightest_res.count) {
          tightest_res = r
          tightest_key_idx = i
        }
        i += 1
      }

      const remaining = Math.max(0, tightest_res.limit - tightest_res.count)
      const policy = `${tightest_res.limit};w=${Math.round(options.windowMs / 1000)}`

      if (!("standardHeaders" in options) || options.standardHeaders === true) {
        res.set({
          "RateLimit-Limit": tightest_res.limit,
          "RateLimit-Remaining": remaining,
          "RateLimit-Reset": tightest_res.resetAt,
          "RateLimit-Policy": policy
        })
      } else {
        res.set({
          "X-RateLimit-Limit": tightest_res.limit,
          "X-RateLimit-Remaining": remaining,
          "X-RateLimit-Reset": tightest_res.resetAt
        })
      }

      if (!tightest_res.allowed) {
        res.set("Retry-After", Math.ceil((tightest_res.resetAt - Date.now()) / 1000))
        res.status(429).json({ message: `[ARL]: rate limit exceeded by key: ${keys[tightest_key_idx]}` })
      } else {
        next()
      }
    } catch (error) {
      if (!("failOpen" in options) || options.failOpen === true) {
        res.set("RateLimit-Status", "degraded")
        next()
      }
      else
        next(Error("[ARL]: error checking rate limits."))
    }
  }
}
