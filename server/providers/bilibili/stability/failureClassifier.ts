import { AppError } from '../../../http.js'
import { readErrorText } from '../access/retryPolicy.js'
import { unwrapFailureCause } from './failureInsights.js'

export type BilibiliFailureType =
  | 'network_error'
  | 'bilibili_412'
  | 'yt_dlp_timeout'
  | 'empty_response'
  | 'media_extract_failed'
  | 'rate_limited'
  | 'restricted'
  | 'dependency_missing'
  | 'unknown_error'

export type FailureSeverity = 'low' | 'medium' | 'high'

export interface ClassifiedFailure {
  type: BilibiliFailureType
  retryable: boolean
  severity: FailureSeverity
  message: string
}

export function classifyFailure(error: unknown): ClassifiedFailure {
  const cause = unwrapFailureCause(error)

  if (cause instanceof AppError) {
    if (cause.error === 'ytdlp_unavailable') {
      return { type: 'dependency_missing', retryable: false, severity: 'high', message: cause.message }
    }
    if (cause.error === 'media_extract_timeout') {
      return { type: 'yt_dlp_timeout', retryable: true, severity: 'medium', message: cause.message }
    }
    if (cause.error === 'media_resolution_failed') {
      return { type: 'media_extract_failed', retryable: true, severity: 'medium', message: cause.message }
    }
    if (cause.error === 'bilibili_blocked_by_upstream') {
      return { type: 'bilibili_412', retryable: true, severity: 'high', message: cause.message }
    }
    if (cause.error === 'bilibili_access_restricted') {
      return { type: 'restricted', retryable: false, severity: 'high', message: cause.message }
    }
  }

  const text = readErrorText(cause).toLowerCase()
  if (text.includes('http error 412') || text.includes('precondition failed') || text.includes('412')) {
    return { type: 'bilibili_412', retryable: true, severity: 'high', message: 'B站返回风控限制' }
  }
  if (text.includes('rate limit') || text.includes('too many requests') || text.includes('429')) {
    return { type: 'rate_limited', retryable: true, severity: 'high', message: 'B站请求过于频繁' }
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return { type: 'yt_dlp_timeout', retryable: true, severity: 'medium', message: 'yt-dlp 请求超时' }
  }
  if (text.includes('empty') || text.includes('no url')) {
    return { type: 'empty_response', retryable: true, severity: 'medium', message: 'B站未返回可用媒体地址' }
  }
  if (text.includes('login') || text.includes('private') || text.includes('drm') || text.includes('region')) {
    return { type: 'restricted', retryable: false, severity: 'high', message: '该 B站资源需要更高访问权限' }
  }
  if (text.includes('econnreset') || text.includes('enotfound') || text.includes('network')) {
    return { type: 'network_error', retryable: true, severity: 'medium', message: 'B站网络请求失败' }
  }
  return { type: 'unknown_error', retryable: true, severity: 'low', message: 'B站解析失败' }
}
