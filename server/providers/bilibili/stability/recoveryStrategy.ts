import { AppError } from '../../../http.js'
import { classifyFailure } from './failureClassifier.js'
import {
  buildFailureInsight,
  getInternalFailureLayer,
  toInsightAppError,
  type FailureInsight,
  type InternalFailureLayer
} from './failureInsights.js'

export type RecoveryState = 'success' | 'retry_once' | 'degrade_mode' | 'give_up'

export function getFailureInsight(
  error: unknown,
  context: 'resolve' | 'media',
  fallbackLayer?: InternalFailureLayer
) {
  const defaultLayer: InternalFailureLayer = context === 'media' ? 'mediaResolver' : 'resolver'
  const layer = getInternalFailureLayer(error, fallbackLayer || defaultLayer)
  return buildFailureInsight(classifyFailure(error), layer)
}

export function shouldDegradeToAnonymous(insight: FailureInsight) {
  return insight.type === 'auth_failure' || insight.type === 'network_failure' || insight.type === 'media_failure'
}

export function toBilibiliFailSafeError(error: unknown, context: 'resolve' | 'media') {
  const insight = getFailureInsight(error, context)
  if (insight.type === 'yt_dlp_failure') {
    return new AppError('ytdlp_unavailable', '未找到或无法运行 yt-dlp，无法解析 B站资源')
  }
  if (insight.type === 'network_failure') {
    return new AppError('bilibili_blocked_by_upstream', 'B站请求受限，请稍后重试或登录后再试')
  }
  if (insight.type === 'auth_failure') {
    return new AppError('bilibili_access_restricted', '该 B站资源需要更高访问权限，或登录状态已经失效')
  }
  return toInsightAppError(insight, context)
}
