import { readFileSync } from "node:fs"
import path from "node:path"

export function registerScript(redis) {
  const lua = readFileSync(path.join(__dirname, "../strategies/record-violation.lua"), "utf8")

  // KEYS[1] = penalty key
  // ARGV[1] = increment per violation
  // ARGV[2] = max multiplier cap
  // ARGV[3] = decayMs (TTL in ms)
  redis.defineCommand("recordViolation", {
    numberOfKeys: 1,
    lua
  })
}

export async function getMultiplier(redis, penaltyKey) {
  const raw = await redis.get(penaltyKey)
  if (raw == null) return 1.0
  const parsed = parseFloat(raw)
  return isNaN(parsed) ? 1.0 : parsed
}

export async function recordViolation(redis, penaltyKey, penaltyOptions) {
  const increment = penaltyOptions?.incrementPerViolation ?? 0.5
  const max = penaltyOptions?.maxMultiplier ?? 4.0
  const decayMs = penaltyOptions?.decayMs ?? 300000
  await redis.recordViolation(penaltyKey, increment, max, decayMs)
}
