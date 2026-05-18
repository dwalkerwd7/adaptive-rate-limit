import Redis from "ioredis"
import { readFileSync } from "fs"
import path from "node:path"

const redis = new Redis(process.env.REDIS_HOST)

const slidingWindowCheckScript = readFileSync(path.join(__dirname, "../strategies/sliding-window-check.lua"))
const recordViolationScript = readFileSync(path.join(__dirname, "../strategies/record-violation.lua"))

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

// KEYS[1] = penalty key
// ARGV[1] = increment
// ARGV[2] = maxMultiplier
// ARGV[3] = decayMs
redis.defineCommand("recordViolation", {
  numberOfKeys: 1,
  lua: recordViolationScript
})

export default redis
