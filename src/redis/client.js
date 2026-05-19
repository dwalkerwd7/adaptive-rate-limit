import Redis from "ioredis"

const redis = new Redis(process.env.ARL_REDIS_HOST)

export default redis
