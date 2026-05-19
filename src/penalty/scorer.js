export function registerScript(redis) {
  const recordViolationScript = readFileSync(path.join(__dirname, "record-violation.lua"))

  // KEYS[1] = penalty key
  // ARGV[1] = increment
  // ARGV[2] = maxMultiplier
  // ARGV[3] = decayMs
  redis.defineCommand("recordViolation", {
    numberOfKeys: 1,
    lua: recordViolationScript
  })
}
