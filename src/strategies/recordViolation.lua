local current = tonumber(redis.call("GET", KEYS[1])) or 1.0
local new = math.min(current + tonumber(ARGV[1]), tonumber(ARGV[2]))

redis.call("SET", KEYS[1], tostring(new), "PX", tonumber(ARGV[3]))

return tostring(new)
