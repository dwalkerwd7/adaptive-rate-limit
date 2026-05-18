local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

-- trim old entries
local cutoff = now - windowMs
redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)

-- count current
local current = redis.call("ZCARD", key)

-- check if limit reached
if current + cost > limit then
	local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
	local resetAt = oldest[2] and (tonumber(oldest[2]) + windowMs) or (now + windowMs)
	return { 0, current, limit, resetAt }
end

-- add new entries
for i = 5, 4 + cost do
	redis.call("ZADD", key, now, ARGV[i])
end

-- refresh TTL
redis.call("PEXPIRE", key, windowMs * 2)

local resetAt = now + windowMs
return { 1, current + cost, limit, resetAt }
