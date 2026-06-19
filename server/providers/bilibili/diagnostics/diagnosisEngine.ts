import type { CookieHealthResult } from '../authContext/index.js'
import type { BilibiliTrace } from '../observability/index.js'
import type { FailureInsight, FailureInsightType } from '../stability/index.js'
import { getMediaMetrics } from '../stability/index.js'

export type DownloadHealth = 'stable' | 'degraded' | 'unstable'

export interface BilibiliDiagnosis {
  rootCause: string
  explanation: string
  suggestedAction: string
  recoverable: boolean
  health: DownloadHealth
}

const priority: Record<FailureInsightType, number> = {
  auth_failure: 5,
  media_failure: 4,
  resolver_failure: 3,
  yt_dlp_failure: 2,
  network_failure: 1
}

function pickPrimaryInsight(insights: FailureInsight[]) {
  return [...insights].sort((left, right) => priority[right.type] - priority[left.type])[0]
}

function authFailureRatio() {
  const metrics = getMediaMetrics()
  const authFailures = Number(metrics.failureTypes.auth_failure || 0)
  return metrics.total ? authFailures / metrics.total : 0
}

export function calculateDownloadHealth(insights: FailureInsight[] = []): DownloadHealth {
  const metrics = getMediaMetrics()
  if (metrics.successRate < 0.5 || authFailureRatio() >= 0.25) return 'unstable'
  if (metrics.successRate <= 0.85 || insights.some((insight) => insight.recoverable)) return 'degraded'
  return 'stable'
}

function diagnosisFor(insight: FailureInsight | undefined, cookieHealth?: CookieHealthResult): Omit<BilibiliDiagnosis, 'health'> {
  if (!insight) {
    return {
      rootCause: '下载状态正常',
      explanation: '最近没有可诊断的 B站下载失败。',
      suggestedAction: '无需处理。',
      recoverable: true
    }
  }

  if (insight.type === 'auth_failure' || cookieHealth?.status === 'invalid' || cookieHealth?.status === 'expired') {
    return {
      rootCause: 'B站登录状态不可用',
      explanation: '当前登录状态可能已经失效，或该资源需要更高访问权限。',
      suggestedAction: '重新登录 B站后再试；如果资源本身受限，只能下载你有权访问的内容。',
      recoverable: true
    }
  }

  if (insight.type === 'media_failure') {
    return {
      rootCause: '无法获取视频资源',
      explanation: '资源列表已经解析，但 B站没有返回可用于下载的视频地址。',
      suggestedAction: '稍后重试，或登录 B站后再试。',
      recoverable: insight.recoverable
    }
  }

  if (insight.type === 'resolver_failure') {
    return {
      rootCause: '资源解析失败',
      explanation: '系统无法稳定读取该 B站链接的合集或视频信息。',
      suggestedAction: '检查链接是否公开可访问，或稍后重试。',
      recoverable: insight.recoverable
    }
  }

  if (insight.type === 'yt_dlp_failure') {
    return {
      rootCause: '本地解析组件不可用',
      explanation: 'yt-dlp 未找到、超时，或返回了无法使用的数据。',
      suggestedAction: '确认 yt-dlp 已准备好，并稍后重试。',
      recoverable: insight.recoverable
    }
  }

  return {
    rootCause: 'B站请求受限',
    explanation: 'B站拒绝了当前请求，可能与访问频率、网络环境或风控有关。',
    suggestedAction: '系统会退避重试；也可以稍后重试或更换网络环境。',
    recoverable: insight.recoverable
  }
}

export function diagnoseBilibiliFailure(
  insights: FailureInsight[],
  trace?: BilibiliTrace,
  cookieHealth?: CookieHealthResult
): BilibiliDiagnosis {
  const primary = pickPrimaryInsight(insights)
  const base = diagnosisFor(primary, cookieHealth)
  const failedStages = trace?.events.filter((event) => event.status === 'fail').length || 0
  const health = calculateDownloadHealth(insights)

  return {
    ...base,
    explanation: failedStages > 1
      ? `${base.explanation} 系统记录到多个失败阶段，并已收敛为最可能原因。`
      : base.explanation,
    health
  }
}
