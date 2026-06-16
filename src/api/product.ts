import type {
  ApiResponse,
  DownloadDashboard,
  DownloadHistoryResult,
  ProductTasksResult,
  ProviderId,
  UnifiedTask
} from '../../shared/types'
import { presentTaskError, type PresentedError } from './product/errorPresenter'
import { clampProgress, mapTaskStatus, type ProductUiStatus } from './product/taskStateMapper'

export type { ProductUiStatus, PresentedError }

export interface ProductUiTask {
  id: string
  title: string
  status: ProductUiStatus
  progress: number
  providerId: ProviderId | 'unknown'
  error?: PresentedError
  createdAt: number
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = (await response.json()) as ApiResponse<T>

  if (!data.ok || !data.result) {
    throw new Error(data.message || data.error || '请求失败')
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

export function normalizeProductTask(task: UnifiedTask): ProductUiTask {
  return {
    id: task.id,
    title: task.title || '未命名任务',
    status: mapTaskStatus(task.status),
    progress: clampProgress(task.progress),
    providerId: task.providerId || 'unknown',
    error: presentTaskError(task),
    createdAt: task.createdAt
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
    items: result.items
      .map(normalizeProductTask)
      .filter((task) => task.status === 'success' || task.status === 'failed')
  }
}
