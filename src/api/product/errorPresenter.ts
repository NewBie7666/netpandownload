import type { UnifiedTask } from '../../../shared/types'

export interface PresentedError {
  title: string
  message: string
  level: 'info' | 'warning' | 'error'
  actionHint?: string
  recoverable: boolean
}

function normalizeErrorText(task: UnifiedTask) {
  return String(task.error || '').toLowerCase()
}

function levelFromRecoverable(recoverable: boolean, health?: string): PresentedError['level'] {
  if (health === 'unstable') return 'error'
  return recoverable ? 'warning' : 'error'
}

function assertPresentedError(error: PresentedError) {
  if (!['info', 'warning', 'error'].includes(error.level)) {
    throw new Error(`Unknown presented error level: ${error.level}`)
  }
  if (!error.title || !error.message || typeof error.recoverable !== 'boolean') {
    throw new Error('Presented error schema is incomplete')
  }
  return error
}

function safePresentedError(input: PresentedError): PresentedError {
  return assertPresentedError({
    title: input.title,
    message: input.message,
    level: input.level,
    actionHint: input.actionHint,
    recoverable: input.recoverable
  })
}

export function presentTaskError(task: UnifiedTask): PresentedError | undefined {
  if (task.diagnosis) {
    return safePresentedError({
      title: task.diagnosis.rootCause,
      message: task.diagnosis.explanation,
      level: levelFromRecoverable(task.diagnosis.recoverable, task.diagnosis.health),
      actionHint: task.diagnosis.suggestedAction,
      recoverable: task.diagnosis.recoverable
    })
  }

  if (!task.error && task.status !== 'error' && task.status !== 'removed') return undefined

  if (task.status === 'removed') {
    return safePresentedError({
      title: '任务已移除',
      message: '该下载任务已从下载中心移除。',
      level: 'info',
      recoverable: false
    })
  }

  const text = normalizeErrorText(task)
  if (text.includes('media_resolution_failed') || text.includes('media_failure') || text.includes('download url')) {
    return safePresentedError({
      title: '无法获取视频资源',
      message: '当前资源暂时没有返回可用于下载的视频地址。',
      level: 'error',
      actionHint: '稍后重试，或登录 B 站后再试。',
      recoverable: true
    })
  }

  if (text.includes('412') || text.includes('blocked') || text.includes('access')) {
    return safePresentedError({
      title: '访问受限',
      message: '服务器拒绝了当前请求，可能与访问频率、登录状态或网络环境有关。',
      level: 'warning',
      actionHint: '系统会尽量自动重试；登录 B 站后成功率可能更高。',
      recoverable: true
    })
  }

  if (text.includes('timeout') || text.includes('timed out')) {
    return safePresentedError({
      title: '请求超时',
      message: '网络响应时间过长，当前任务暂时无法继续。',
      level: 'warning',
      actionHint: '稍后重试。',
      recoverable: true
    })
  }

  if (text.includes('auth') || text.includes('cookie') || text.includes('login')) {
    return safePresentedError({
      title: '登录状态不可用',
      message: '当前登录状态不可用，或资源需要更高访问权限。',
      level: 'warning',
      actionHint: '重新登录 B 站，或换成公开资源重试。',
      recoverable: true
    })
  }

  return safePresentedError({
    title: '下载失败',
    message: '可能是访问限制、网络问题或视频资源暂时不可用。',
    level: 'error',
    actionHint: '请稍后重试。',
    recoverable: true
  })
}
