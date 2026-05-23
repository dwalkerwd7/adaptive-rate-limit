const toProperValue = (value) => {
  return value.toString().toLowerCase().replaceAll(/[:\s]/g, "")
}

export default function resolveIdentifiers(req, config) {
  let identifiers = []

  if (config && "identifiers" in config) {
    for (let i of config.identifiers) {
      if (typeof i !== "string")
        i = "ip"
      else
        i = toProperValue(i)

      switch (i) {
        case "ip":
          identifiers.push({
            type: "ip", extractor: (req) => {
              if (req.ip) {
                return toProperValue(req.ip)
              } else {
                return null
              }
            }
          })
          break
        case "userId":
          identifiers.push({
            type: "userId", extractor: (req) => {
              if (req?.user) {
                if (req.user?.id) return toProperValue(req.user.id)
                else if (req.user?.userId) return toProperValue(req.user.userId)
                else if (req.user?.sub) return toProperValue(req.user.sub)
                else return null
              }
            }
          })
          break
        case "sessionId":
          identifiers.push({
            type: "sessionId", extractor: (req) => {
              if (req?.sessionID) return toProperValue(req.sessionID)
              else return null
            }
          })
          break
        case "apiKey":
          identifiers.push({
            type: "apiKey", value: (req) => {
              if ("x-api-key" in req.headers) return toProperValue(req.headers["x-api-key"])
              else return null
            }
          })
          break
        default:
          if ("type" in i && "extractor" in i) {
            if (i.extractor) {
              identifiers.push({ type: toProperValue(i.type), extractor: toProperValue(i.extractor(req)) })
            }
          }
          break
      }
    }
  }

  return identifiers
}
