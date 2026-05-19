import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest"
import redis from "../../src/redis/client"
import { check, registerScript } from "../../src/strategies/sliding-window"

const mockIpKey = "rl:window:ip:0.0.0.1"
let res = null

describe("check", () => {
  beforeAll(() => {
    registerScript(redis)
  })

  beforeEach(async () => {
    await redis.flushdb()
    res = {
      allowed: 0,
      count: 0,
      limit: 0,
      resetAt: 0
    }
  })

  afterAll(async () => {
    await redis.flushdb()
    await redis.quit()
  })

  it("allows any amount of requests if cost === 0", async () => {
    res = await check(redis, mockIpKey, 60_000, 1, 0)
    res = await check(redis, mockIpKey, 60_000, 1, 0)

    expect(res.allowed).toEqual(1)
    expect(res.count).toEqual(0) // it shouldn't record the key at all if cost is 0
  })

  it("allows 100 requests with a cost of 1 at a limit of 100", async () => {
    for (let i = 0; i < 100; i++) {
      res = await check(redis, mockIpKey, 60_000, 100, 1)
    }

    expect(res.allowed).toEqual(1)
    expect(res.count).toEqual(100)
  })

  it("does not allow 101 requests at a cost of 1 and a limit of 100", async () => {
    for (let i = 0; i < 100; i++) {
      res = await check(redis, mockIpKey, 60_000, 100, 1)
    }

    res = await check(redis, mockIpKey, 60_000, 100, 1)

    expect(res.allowed).toEqual(0)
    expect(res.count).toEqual(100)
    expect(await redis.zcard(mockIpKey)).toEqual(100)
  })

  it("allows 5 requests at a cost of 5 and a limit of 25", async () => {
    for (let i = 0; i < 5; i++) {
      res = await check(redis, mockIpKey, 60_000, 25, 5)
    }

    expect(res.allowed).toEqual(1)
    expect(res.count).toEqual(25)
  })

  it("does not allow 6 requests at a cost of 5 and a limit of 25", async () => {
    for (let i = 0; i < 5; i++) {
      res = await check(redis, mockIpKey, 60_000, 25, 5)
    }

    res = await check(redis, mockIpKey, 60_000, 25, 5)

    expect(res.allowed).toEqual(0)
    expect(res.count).toEqual(25)
    expect(await redis.zcard(mockIpKey)).toEqual(25)
  })

  it("allows another request after time windowMs", async () => {
    res = await check(redis, mockIpKey, 1_000, 1, 1)
    setTimeout(async () => {
      res = await check(redis, mockIpKey, 1_000, 1, 1)

      expect(res.allowed).toEqual(1)
      expect(res.count).toEqual(2)
    }, 1000)
  })

  it("does not allow another request before time windowMs", async () => {
    res = await check(redis, mockIpKey, 1_000, 1, 1)
    setTimeout(async () => {
      res = await check(redis, mockIpKey, 1_000, 1, 1)

      expect(res.allowed).toEqual(0)
      expect(res.count).toEqual(1)
    }, 500)
  })
})
