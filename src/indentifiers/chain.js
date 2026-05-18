export default function resolveIdentifiers(req, config) {
  let identifiers = []

  if (config && "identifiers" in config) {
    for (const i of config.identifiers) {
      if (typeof i === "string") {
        switch (i) {
          case "ip":
            identifiers.push({ type: i, value: req.ip.toString() })
            break
          case "userId":
            identifiers.push({ type: i, value: req.user.id.toString() })
            break
          case "sessionId":
            identifiers.push({ type: i, value: req.sessionID.toString() })
            break
          case "apiKey":
            identifiers.push({ type: i, value: req.headers["x-api-key"].toString() })
            break
        }
      } else {
        if ("type" in i && "extractor" in i) {
          if (i.extractor) {
            identifiers.push({ type: i.type.toString(), value: i.extractor(req).toString() })
          }
        }
      }
    }
  } else {
    identifiers.push({ type: "ip", value: req.ip.toString() })
  }

  return identifiers
}
