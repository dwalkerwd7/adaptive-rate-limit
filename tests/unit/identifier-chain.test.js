import { describe, expect, it, vi } from "vitest"
import resolveIdentifiers from "../../src/indentifiers/chain"

const req = {
  ip: "0.0.0.1",
  user: {
    id: 999
  },
  sessionID: 0,
  headers: {
    "x-api-key": "abc123"
  }
}

describe("resolveIdentifiers", () => {
  it("resolves all preset identifiers", () => {
    const res = resolveIdentifiers(req, {
      identifiers: ['ip', 'userId', 'sessionId', 'apiKey']
    })

    expect(Array.isArray(res)).toBe(true)
    expect(res.length).toEqual(4)
    expect(res).toContainEqual({
      type: 'ip',
      value: '0.0.0.1'
    })
    expect(res).toContainEqual({
      type: 'userId',
      value: '999'
    })
    expect(res).toContainEqual({
      type: 'sessionId',
      value: '0'
    })
    expect(res).toContainEqual({
      type: 'apiKey',
      value: 'abc123'
    })
  })

  it("resolves all custom identifiers with defined extractors", () => {
    const res = resolveIdentifiers(req, {
      identifiers: [
        { type: 'email', extractor: (_) => "some.email@gmail.com" }
      ]
    })


    expect(Array.isArray(res)).toBe(true)
    expect(res).toContainEqual({
      type: "email",
      value: "some.email@gmail.com"
    })
  })

  it("skips all undefined extractor identifiers", () => {
    const res = resolveIdentifiers(req, {
      identifiers: ["ip", { type: "custom", extractor: null }]
    })

    expect(Array.isArray(res)).toBe(true)
    expect(res.length).toEqual(1)
  })

  it("skips all invalid preset identifiers", () => {
    const res = resolveIdentifiers(req, {
      identifiers: ["oops", "wrong", "ip"]
    })


    expect(Array.isArray(res)).toBe(true)
    expect(res.length).toEqual(1)
  })

  it("throws for no req.user.id property"), () => {
    const falseReq = { user: { _id: 1 } }
    const fnSpy = vi.spyOn({
      "resolveIdentifiers": resolveIdentifiers
    }, "resolveIdentifiers")

    resolveIdentifiers(falseReq, {
      identifiers: ["userId"]
    })

    expect(fnSpy).toThrow()
  }

  it("defaults to ip identifier", () => {
    const res = resolveIdentifiers(req, {})

    expect(Array.isArray(res)).toBe(true)
    expect(res).toContainEqual({
      type: "ip",
      value: "0.0.0.1"
    })
  })
})
