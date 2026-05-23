import crypto from "node:crypto"

export function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32)
}
