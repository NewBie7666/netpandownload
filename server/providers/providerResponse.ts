import { AppError } from '../http.js'
import { recordExecutionTrace, type ProviderOperation } from './executionTrace.js'
import type {
  FallbackProviderResponse,
  ProviderError,
  ProviderErrorCode,
  ProviderId,
  ProviderResponse,
  ProviderResultKind,
  ProviderSource
} from './types.js'

export interface InternalExecutionContract<T> {
  kind: ProviderResultKind
  ok: boolean
  providerId: ProviderId
  operation: ProviderOperation
  data?: T | null
  error?: ProviderError
  meta: {
    runtime: {
      traceId: string
      durationMs: number
      source?: ProviderSource
      executable: boolean
    }
    provider: {
      providerMeta?: unknown
      reason?: string
    }
  }
}

export function providerOk<T>(
  providerId: ProviderId,
  data: T,
  source: ProviderSource = 'real',
  reason?: string,
  providerMeta?: unknown
): ProviderResponse<T> {
  return {
    kind: 'success',
    ok: true,
    providerId,
    data,
    meta: {
      source,
      reason,
      providerMeta
    }
  }
}

export function providerError<T = never>(
  providerId: ProviderId,
  code: ProviderErrorCode,
  message: string,
  recoverable = true,
  source?: ProviderSource,
  reason?: string,
  providerMeta?: unknown
): ProviderResponse<T> {
  return {
    kind: 'error',
    ok: false,
    providerId,
    data: null,
    error: {
      code,
      message,
      recoverable
    },
    meta: {
      source,
      reason,
      providerMeta
    }
  }
}

export function buildFallback(
  providerId: ProviderId,
  reason: string,
  message = '降级数据不可执行',
  code: ProviderErrorCode = 'blocked_by_upstream',
  providerMeta?: unknown
): FallbackProviderResponse {
  return {
    kind: 'fallback',
    ok: false,
    providerId,
    data: null,
    error: {
      code,
      message,
      recoverable: true
    },
    meta: {
      source: 'fallback',
      reason,
      providerMeta
    }
  }
}

export function toInternalExecutionContract<T>(
  response: ProviderResponse<T>,
  operation: ProviderOperation,
  startedAt = Date.now()
): InternalExecutionContract<T> {
  const source = response.meta?.source
  const executable = response.kind === 'success' && source !== 'fallback'
  const error = response.kind === 'success' ? undefined : response.error
  const trace = recordExecutionTrace({
    providerId: response.providerId,
    operation,
    kind: response.kind,
    errorCode: error?.code,
    source,
    executable,
    startedAt
  })

  return {
    kind: response.kind,
    ok: response.kind === 'success',
    providerId: response.providerId,
    operation,
    data: response.kind === 'success' ? response.data : null,
    error,
    meta: {
      runtime: {
        traceId: trace.traceId,
        durationMs: trace.durationMs,
        source,
        executable
      },
      provider: {
        providerMeta: response.meta?.providerMeta,
        reason: response.meta?.reason
      }
    }
  }
}

export function toAppError(error: ProviderError, status = 400) {
  return new AppError(error.code, error.message, status)
}

export function providerCapabilityError<T = never>(
  providerId: ProviderId,
  operation: ProviderOperation,
  message = '该 Provider 不支持当前操作'
) {
  return providerError<T>(providerId, operation === 'download' ? 'restricted' : 'parse_failed', message, false)
}

function hasText(error: unknown, patterns: string[]) {
  const text = error instanceof Error ? error.message : String(error || '')
  const lowered = text.toLowerCase()
  return patterns.some((pattern) => lowered.includes(pattern))
}

export function normalizeProviderError(
  providerId: ProviderId,
  error: unknown,
  context: 'resolve' | 'list' | 'download'
): ProviderError {
  if (error instanceof AppError) {
    return {
      code: mapAppErrorCode(providerId, error.error, context),
      message: error.message,
      recoverable: true
    }
  }

  if (providerId === 'bilibili') {
    if (hasText(error, ['http error 412', 'precondition failed', '412'])) {
      return {
        code: 'blocked_by_upstream',
        message: 'B站返回风控限制，当前版本未接入 B站登录态，无法保证解析成功',
        recoverable: true
      }
    }
    if (hasText(error, ['timed out', 'timeout', 'econnreset', 'enotfound', 'network'])) {
      return {
        code: 'network_error',
        message: 'Bilibili 解析请求失败，请稍后重试',
        recoverable: true
      }
    }
  }

  return {
    code: context === 'download' ? 'network_error' : 'parse_failed',
    message: error instanceof Error ? error.message : 'Provider 处理失败',
    recoverable: true
  }
}

function mapAppErrorCode(
  providerId: ProviderId,
  errorCode: string,
  context: 'resolve' | 'list' | 'download'
): ProviderErrorCode {
  if (errorCode === 'unsupported_provider') return 'unsupported_provider'

  if (providerId === 'bilibili') {
    if (errorCode === 'bilibili_resolve_failed') return 'bilibili_resolve_failed'
    if (errorCode === 'ytdlp_unavailable') return 'dependency_missing'
    if (errorCode === 'bilibili_blocked_by_upstream') return 'blocked_by_upstream'
    if (errorCode === 'bilibili_dash_unsupported') return 'dash_unsupported'
    if (errorCode === 'bilibili_access_restricted') return 'restricted'
    if (errorCode === 'bilibili_ytdlp_failed') return 'network_error'
    if (errorCode === 'bilibili_network_error') return 'network_error'
    if (errorCode === 'episode_cache_miss') return 'episode_cache_miss'
    if (errorCode === 'episode_inconsistent_state') return 'episode_inconsistent_state'
    if (errorCode === 'download_url_missing') return 'download_url_missing'
    if (errorCode === 'media_resolution_failed') return 'media_resolution_failed'
    if (errorCode === 'media_extract_timeout') return 'media_extract_timeout'
    return context === 'download' ? 'network_error' : 'parse_failed'
  }

  if (
    [
      'missing_session',
      'missing_credentials',
      'missing_share_fid_token',
      'missing_share_file_token',
      'quark_auth_session_missing',
      'quark_auth_failed'
    ].includes(errorCode)
  ) {
    return 'auth_required'
  }

  if (
    [
      'download_restricted',
      'quark_download_limited',
      'quark_save_task_missing',
      'quark_save_task_timeout',
      'quark_saved_file_missing',
      'quark_share_unavailable'
    ].includes(errorCode)
  ) {
    return 'restricted'
  }

  if (['network_error', 'quark_network_error', 'quark_timeout'].includes(errorCode)) {
    return 'network_error'
  }

  if (
    [
      'empty_share_url',
      'invalid_share_url',
      'unsupported_share_url',
      'quark_unexpected_response',
      'quark_passcode_invalid',
      'empty_download_url',
      'invalid_file'
    ].includes(errorCode)
  ) {
    return 'parse_failed'
  }

  return context === 'download' ? 'network_error' : 'parse_failed'
}
