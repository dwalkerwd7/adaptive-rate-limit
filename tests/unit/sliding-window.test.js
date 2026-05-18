import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import redis from "../../src/redis/client"
import check from "../../src/strategies/sliding-window"

const mockIpKey = "rl:window:ip:0.0.0.1"

describe("check", () => {
  beforeEach(async () => {
    await redis.flushdb()
  })

  afterAll(async () => {
    await redis.flushdb()
    await redis.quit()
  })

  it("allows any amount of requests if cost === 0", async () => {
    let res = {
      allowed: 0,
      count: 0,
      limit: 0,
      resetAt: 0
    }

    res = await check(redis, mockIpKey, 60_000, 1, 0)
    res = await check(redis, mockIpKey, 60_000, 1, 0)

    expect(res.allowed).toEqual(1)
    expect(res.count).toEqual(0) // it shouldn't record the key at all if cost is 0
  })

  it("allows 100 requests with a cost of 1 at a limit of 100", async () => {
    let res = {
      allowed: 0,
      count: 0,
      limit: 0,
      resetAt: 0
    }

    for (let i = 0; i < 100; i++) {
      res = await check(redis, mockIpKey, 60_000, 100, 1)
    }

    expect(res.allowed).toEqual(1)
    expect(res.count).toEqual(100)
  })
})
