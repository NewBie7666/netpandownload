import { AppError } from '../../../http.js'
import type { BilibiliFailureType, ClassifiedFailure } from './failureClassifier.js'

export type FailureInsightType =
  | 'auth_failure'
  | 'media_failure'
  | 'resolver_failure'
  | 'network_failure'
  | 'yt_dlp_failure'

export type FailureInsightLayer = 'resolver' | 'media' | 'auth' | 'network'

export type InternalFailureLayer =
  | FailureInsightLayer
  | 'access'
  | 'ytDlp'
  | 'mediaResolver'
  | 'mediaExtractor'
  | 'authContext'

export interface FailureInsight {
  type: FailureInsightType
  layer: FailureInsightLayer
  code: string
  humanMessage: string
  recoverable: boolean
}

export class BilibiliLayeredError extends Error {
  readonly cause: unknown
  readonly layer: InternalFailureLayer

  constructor(layer: InternalFailureLayer, error: unknown) {
    super(error instanceof Error ? error.message : String(error || 'Bilibili request failed'))
    this.name = 'BilibiliLayeredError'
    this.cause = error
    this.layer = layer
  }
}

export function withFailureLayer<T>(layer: InternalFailureLayer, operation: () => Promise<T>): Promise<T> {
  return operation().catch((error) => {
    throw new BilibiliLayeredError(layer, error)
  })
}

export function unwrapFailureCause(error: unknown) {
  return error instanceof BilibiliLayeredError ? error.cause : error
}

export function getInternalFailureLayer(error: unknown, fallback: InternalFailureLayer): InternalFailureLayer {
  return error instanceof BilibiliLayeredError ? error.layer : fallback
}

function normalizeLayer(layer: InternalFailureLayer): FailureInsightLayer {
  if (layer === 'authContext' || layer === 'auth') return 'auth'
  if (layer === 'access' || layer === 'network') return 'network'
  if (layer === 'mediaResolver' || layer === 'mediaExtractor' || layer === 'media') return 'media'
  return 'resolver'
}

export function getFailureLayer(error: unknown, fallback: InternalFailureLayer): FailureInsightLayer {
  return normalizeLayer(getInternalFailureLayer(error, fallback))
}

function mapType(type: BilibiliFailureType, layer: FailureInsightLayer, internalLayer: InternalFailureLayer): FailureInsightType {
  if (type === 'restricted') return 'auth_failure'
  if (type === 'dependency_missing' || internalLayer === 'ytDlp') return 'yt_dlp_failure'
  if (type === 'network_error' || type === 'rate_limited' || type === 'bilibili_412') return 'network_failure'
  if (layer === 'resolver') return 'resolver_failure'
  return 'media_failure'
}

function humanMessage(type: FailureInsightType, classified: ClassifiedFailure) {
  if (type === 'auth_failure') return 'B站登录状态不可用，或资源需要更高访问权限'
  if (type === 'media_failure') return '无法获取视频下载地址，请稍后重试'
  if (type === 'network_failure') return 'B站请求受限或网络响应异常'
  if (type === 'yt_dlp_failure') return '本地解析组件暂时无法完成解析'
  return classified.message || 'B站资源解析失败'
}

export function buildFailureInsight(classified: ClassifiedFailure, layer: InternalFailureLayer): FailureInsight {
  const stableLayer = normalizeLayer(layer)
  const type = mapType(classified.type, stableLayer, layer)
  return {
    type,
    layer: stableLayer,
    code: classified.type,
    humanMessage: humanMessage(type, classified),
    recoverable: classified.retryable
  }
}

export function toInsightAppError(insight: FailureInsight, context: 'resolve' | 'media') {
  if (insight.type === 'auth_failure') {
    return new AppError('bilibili_access_restricted', insight.humanMessage)
  }
  if (insight.type === 'yt_dlp_failure') {
    return new AppError('ytdlp_unavailable', insight.humanMessage)
  }
  if (context === 'media') {
    return new AppError('media_resolution_failed', insight.humanMessage)
  }
  return new AppError('bilibili_network_error', insight.humanMessage)
}
