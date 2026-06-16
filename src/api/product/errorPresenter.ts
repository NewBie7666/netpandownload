import type { UnifiedTask } from '../../../shared/types'

export interface PresentedError {
  title: string
  message: string
  level: 'info' | 'warning' | 'error'
  actionHint?: string
}

function normalizeErrorText(task: UnifiedTask) {
  return String(task.error || '').toLowerCase()
}

export function presentTaskError(task: UnifiedTask): PresentedError | undefined {
  if (!task.error && task.status !== 'error' && task.status !== 'removed') return undefined

  if (task.status === 'removed') {
    return {
      title: '任务已移除',
      message: '该下载任务已从列表中移除。',
      level: 'info'
    }
  }

  const text = normalizeErrorText(task)
  if (text.includes('media_resolution_failed') || text.includes('媒体') || text.includes('download url')) {
    return {
      title: '无法获取视频资源',
      message: 'B站当前限制导致无法解析视频下载地址。',
      level: 'error',
      actionHint: '稍后重试或更换网络环境'
    }
  }

  if (text.includes('412') || text.includes('blocked') || text.includes('风控') || text.includes('access')) {
    return {
      title: '访问受限',
      message: 'B站服务器拒绝了当前请求。',
      level: 'warning',
      actionHint: '系统将自动重试'
    }
  }

  if (text.includes('timeout') || text.includes('超时')) {
    return {
      title: '请求超时',
      message: '网络响应时间过长。',
      level: 'warning',
      actionHint: '稍后自动重试'
    }
  }

  return {
    title: '下载失败',
    message: '可能是访问限制、网络问题或视频资源暂时不可用。',
    level: 'error',
    actionHint: '请稍后重试'
  }
}
