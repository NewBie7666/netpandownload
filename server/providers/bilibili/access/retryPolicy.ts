export const maxAccessRetries = 2
const backoffMs = [500, 1500]

export type BilibiliAccessReason =
  | '412_or_network_block'
  | 'dependency_missing'
  | 'empty_response'
  | 'parse_failed'
  | 'network_error'
  | 'restricted'
  | 'unknown'

export class BilibiliAccessError extends Error {
  reason: BilibiliAccessReason
  retryable: boolean
  statusCode?: number

  constructor(reason: BilibiliAccessReason, message: string, retryable = true, statusCode?: number) {
    super(message)
    this.name = 'BilibiliAccessError'
    this.reason = reason
    this.retryable = retryable
    this.statusCode = statusCode
  }
}

export function readErrorText(error: unknown) {
  const parts = [
    error instanceof Error ? error.message : '',
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr || '')
      : '',
    typeof error === 'object' && error !== null && 'stdout' in error
      ? String((error as { stdout?: unknown }).stdout || '')
      : ''
  ]
  return parts.filter(Boolean).join('\n')
}

export function classifyAccessError(error: unknown): BilibiliAccessError {
  if (error instanceof BilibiliAccessError) return error

  const text = readErrorText(error).toLowerCase()
  if (text.includes('http error 412') || text.includes('precondition failed') || text.includes('412')) {
    return new BilibiliAccessError('412_or_network_block', 'Bilibili access was blocked by upstream risk control', true, 412)
  }
  if (
    text.includes('login') ||
    text.includes('private') ||
    text.includes('drm') ||
    text.includes('region') ||
    text.includes('member') ||
    text.includes('paid')
  ) {
    return new BilibiliAccessError('restricted', 'Bilibili resource requires restricted access', false)
  }
  if (
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('econnreset') ||
    text.includes('enotfound') ||
    text.includes('network')
  ) {
    return new BilibiliAccessError('network_error', 'Bilibili access network request failed', true)
  }
  if (text.includes('unexpected end') || text.includes('json') || text.includes('parse')) {
    return new BilibiliAccessError('parse_failed', 'Bilibili access response could not be parsed', true)
  }
  return new BilibiliAccessError('unknown', 'Bilibili access failed', true)
}

export function shouldRetryAccess(error: unknown, retryCount: number) {
  const classified = classifyAccessError(error)
  return classified.retryable && retryCount < maxAccessRetries
}

export async function waitBeforeRetry(retryCount: number) {
  const ms = backoffMs[Math.min(retryCount, backoffMs.length - 1)] || backoffMs[backoffMs.length - 1]
  await new Promise((resolve) => setTimeout(resolve, ms))
}
