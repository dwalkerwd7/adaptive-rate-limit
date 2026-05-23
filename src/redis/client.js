import Redis from "ioredis"

export default function createClient(ioRedisOpts) {
  return new Redis(ioRedisOpts)
}
