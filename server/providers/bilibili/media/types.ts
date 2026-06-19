import type { AccessContext } from '../access/context.js'
import type { BilibiliTraceContext } from '../observability/index.js'

export type BilibiliMediaErrorReason =
  | 'media_resolution_failed'
  | 'media_extract_timeout'
  | 'dependency_missing'
  | 'blocked_by_upstream'
  | 'restricted'

export interface BilibiliMediaResult {
  url: string
  expiresAt: string
}

export interface ResolveMediaOptions {
  timeoutMs?: number
  accessContext?: AccessContext
  traceContext?: BilibiliTraceContext
  episodeInfo?: unknown
}
