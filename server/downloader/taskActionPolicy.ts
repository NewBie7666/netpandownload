import type { DownloadTaskStatus } from '../../shared/types.js'
import { AppError } from '../http.js'

export function requireTaskAction(action: 'pause' | 'resume', status: DownloadTaskStatus): boolean {
  if (action === 'pause') {
    if (status === 'paused') return false
    if (status === 'active' || status === 'waiting') return true
  }
  if (action === 'resume') {
    if (status === 'active' || status === 'waiting') return false
    if (status === 'paused') return true
  }
  throw new AppError('download_task_action_invalid', '无法对当前状态的任务执行' + (action === 'pause' ? '暂停' : '继续'), 409)
}
