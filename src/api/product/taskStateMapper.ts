import type { UnifiedTask } from '../../../shared/types'

export type ProductUiStatus = 'waiting' | 'active' | 'paused' | 'success' | 'failed'

export function mapTaskStatus(status: UnifiedTask['status']): ProductUiStatus {
  if (status === 'queued' || status === 'pending') return 'waiting'
  if (status === 'running') return 'active'
  if (status === 'paused') return 'paused'
  if (status === 'done') return 'success'
  return 'failed'
}

export function clampProgress(value: number | undefined) {
  if (value === undefined || value === null || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Number(value)))
}
