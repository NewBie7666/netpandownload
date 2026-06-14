import { AppError } from '../http.js'
import type {
  ProviderError,
  ProviderErrorCode,
  ProviderId,
  ProviderResponse,
  ProviderSource
} from './types.js'

export function providerOk<T>(
  providerId: ProviderId,
  data: T,
  source: ProviderSource = 'real',
  reason?: string
): ProviderResponse<T> {
  return {
    providerId,
    status: 'ok',
    data,
    meta: reason ? { source, reason } : { source }
  }
}

export function providerError<T = never>(
  providerId: ProviderId,
  code: ProviderErrorCode,
  message: string,
  recoverable = true
): ProviderResponse<T> {
  return {
    providerId,
    status: 'error',
    error: {
      code,
      message,
      recoverable
    }
  }
}

export function buildFallback<T>(
  providerId: ProviderId,
  data: T,
  reason: string
): ProviderResponse<T> {
  return providerOk(providerId, data, 'fallback', reason)
}

export function toAppError(error: ProviderError, status = 400) {
  return new AppError(error.code, error.message, status)
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
    if (errorCode === 'ytdlp_unavailable') return 'dependency_missing'
    if (errorCode === 'bilibili_blocked_by_upstream') return 'blocked_by_upstream'
    if (errorCode === 'bilibili_dash_unsupported') return 'dash_unsupported'
    if (errorCode === 'bilibili_access_restricted') return 'restricted'
    if (errorCode === 'bilibili_ytdlp_failed') return 'network_error'
    if (errorCode === 'bilibili_network_error') return 'network_error'
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
