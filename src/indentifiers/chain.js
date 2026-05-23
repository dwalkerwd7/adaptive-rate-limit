const toProperValue = (value) => {
  return value.toString().toLowerCase().replaceAll(/[:\s]/g, "")
}

export default function resolveIdentifiers(config) {
  const identifiers = []

  if (!config || !("identifiers" in config) || !config.identifiers?.length) {
    return [{ type: "ip", extractor: (req) => req.ip ? toProperValue(req.ip) : null }]
  }

  for (const entry of config.identifiers) {
    if (typeof entry !== "string") {
      // custom object identifier: { type, extractor }
      if (entry && typeof entry === "object" && typeof entry.extractor === "function") {
        identifiers.push({ type: String(entry.type), extractor: entry.extractor })
      }
      continue
    }

    switch (toProperValue(entry)) {
      case "ip":
        identifiers.push({
          type: "ip",
          extractor: (req) => req.ip ? toProperValue(req.ip) : null
        })
        break
      case "userid":
        identifiers.push({
          type: "userId",
          extractor: (req) => {
            if (!req?.user) return null
            const raw = req.user?.id ?? req.user?.userId ?? req.user?.sub
            return raw != null ? toProperValue(raw) : null
          }
        })
        break
      case "sessionid":
        identifiers.push({
          type: "sessionId",
          extractor: (req) => req?.sessionID ? toProperValue(req.sessionID) : null
        })
        break
      case "apikey":
        identifiers.push({
          type: "apiKey",
          extractor: (req) => "x-api-key" in req.headers ? toProperValue(req.headers["x-api-key"]) : null
        })
        break
    }
  }

  return identifiers
}
