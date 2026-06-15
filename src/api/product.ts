import type {
  ApiResponse,
  DownloadDashboard,
  DownloadHistoryResult,
  ProductTasksResult,
  UnifiedTask
} from '../../shared/types'

export type ProductUiStatus = 'waiting' | 'active' | 'paused' | 'success' | 'failed'

export interface ProductUiError {
  code: string
  message: string
  recoverable: boolean
}

export interface ProductUiTask extends Omit<UnifiedTask, 'status' | 'progress' | 'error'> {
  rawStatus: UnifiedTask['status']
  status: ProductUiStatus
  progress: number
  error?: ProductUiError
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = (await response.json()) as ApiResponse<T>

  if (!data.ok || !data.result) {
    throw new Error(data.message || data.error || 'Request failed')
  }

  return data.result
}

export function fetchProductTasks() {
  return getJson<ProductTasksResult>('/api/product/tasks')
}

export function fetchProductDashboard() {
  return getJson<DownloadDashboard>('/api/product/dashboard')
}

export function fetchProductHistory() {
  return getJson<DownloadHistoryResult>('/api/product/history')
}

function normalizeStatus(status: UnifiedTask['status']): ProductUiStatus {
  if (status === 'queued' || status === 'pending') return 'waiting'
  if (status === 'running') return 'active'
  if (status === 'done') return 'success'
  if (status === 'paused') return 'paused'
  return 'failed'
}

function normalizeProgress(value: number | undefined) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Number(value)))
}

function normalizeError(task: UnifiedTask): ProductUiError | undefined {
  if (!task.error && task.status !== 'error' && task.status !== 'removed') return undefined

  return {
    code: task.status === 'removed' ? 'task_removed' : 'task_error',
    message: task.error || (task.status === 'removed' ? '任务已移除' : '任务执行失败'),
    recoverable: false
  }
}

export function normalizeProductTask(task: UnifiedTask): ProductUiTask {
  return {
    ...task,
    rawStatus: task.status,
    status: normalizeStatus(task.status),
    progress: normalizeProgress(task.progress),
    error: normalizeError(task)
  }
}

export async function fetchProductTaskViews() {
  const result = await fetchProductTasks()
  return {
    tasks: result.tasks.map(normalizeProductTask)
  }
}

export async function fetchProductHistoryViews() {
  const result = await fetchProductHistory()
  return {
    items: result.items.map(normalizeProductTask).filter((task) => (
      task.status === 'success' || task.status === 'failed'
    ))
  }
}
