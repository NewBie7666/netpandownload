import { createHash } from 'node:crypto'
import { normalizeBiliUrl } from '../resolver/index.js'

export type TraceOperation = 'resolve' | 'list' | 'download'

export interface BilibiliTraceContext {
  readonly traceId: string
  readonly normalizedUrl: string
  readonly operation: TraceOperation
  readonly startedAt: number
}

function hashTrace(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function createTraceContext(url: string, operation: TraceOperation): BilibiliTraceContext {
  const normalizedUrl = normalizeBiliUrl(url)
  const startedAt = Date.now()
  return Object.freeze({
    traceId: hashTrace(`${operation}:${normalizedUrl}:${startedAt}`),
    normalizedUrl,
    operation,
    startedAt
  })
}
