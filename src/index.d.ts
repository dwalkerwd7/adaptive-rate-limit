import type { RequestHandler, Request } from 'express'
import type { Redis, RedisOptions } from 'ioredis'

// ─── Identifier ────────────────────────────────────────────────────────────

export type IdentifierPreset = 'ip' | 'user' | 'userId' | 'apiKey' | 'session' | 'sessionId'

export interface CustomIdentifier {
  type: string
  extractor: (req: Request) => string | null | undefined
}

export type IdentifierConfig = IdentifierPreset | CustomIdentifier

// ─── Callbacks ─────────────────────────────────────────────────────────────

export interface LimitInfo {
  identifier: { type: string }
  limit: number
  baseLimit: number
  current: number
  cost: number
  windowMs: number
  resetAt: number
  adaptiveFactor: number
  penaltyMultiplier: number
  allowed: boolean
}

export interface ViolationInfo {
  identifier: { type: string }
  previousMultiplier: number
  newMultiplier: number
  decayMs: number
}

// ─── Options ───────────────────────────────────────────────────────────────

export interface AdaptiveOptions {
  enabled?: boolean
  minFactor?: number
  maxFactor?: number
  pollIntervalMs?: number
  cpuThreshold?: number
}

export interface PenaltyOptions {
  enabled?: boolean
  maxMultiplier?: number
  incrementPerViolation?: number
  decayMs?: number
}

export interface RateLimiterOptions {
  redis: Redis | RedisOptions
  keyPrefix?: string

  windowMs: number
  limit: number

  identifiers?: IdentifierConfig[]

  routeCosts?: Record<string, number>
  costResolver?: (req: Request) => number

  adaptive?: AdaptiveOptions
  penalty?: PenaltyOptions

  failOpen?: boolean
  standardHeaders?: boolean

  onLimit?: (req: Request, res: import('express').Response, info: LimitInfo) => void
  onViolation?: (req: Request, info: ViolationInfo) => void
  onDegraded?: (req: Request, error: Error) => void
  onAllowed?: (req: Request, info: LimitInfo) => void
}

// ─── Inspection types ──────────────────────────────────────────────────────

export interface IdentifierState {
  type: string
  value: string
  currentCount: number
  windowMs: number | null
  resetAt: number | null
  penaltyMultiplier: number
  penaltyExpiresAt: number | null
}

export interface IdentifierSummary {
  type: string
  valueHash: string
  currentCount: number
  penaltyMultiplier: number
}

export interface ListIdentifiersResult {
  cursor: string
  identifiers: IdentifierSummary[]
}

export interface ListOptions {
  cursor?: string
  count?: number
  filterType?: string
  keyPrefix?: string
}

export interface InspectOptions {
  keyPrefix?: string
  windowMs?: number
}

export interface LoadMetrics {
  enabled: boolean
  currentFactor: number
  cpuPercent: number
  lastSampleAt: number
  cpuThreshold: number
}

// ─── Public API ────────────────────────────────────────────────────────────

export default function createRateLimiter(options: RateLimiterOptions): RequestHandler

export function inspectIdentifier(
  redis: Redis,
  type: string,
  value: string,
  opts?: InspectOptions,
): Promise<IdentifierState | null>

export function listActiveIdentifiers(
  redis: Redis,
  opts?: ListOptions,
): Promise<ListIdentifiersResult>

export function getLoadMetrics(): LoadMetrics

export function resetIdentifier(
  redis: Redis,
  type: string,
  value: string,
  opts?: { keyPrefix?: string },
): Promise<void>
