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

export type ProductHealth = 'stable' | 'degraded' | 'unstable'

export interface ProductDiagnosis {
  rootCause: string
  explanation: string
  suggestedAction: string
  recoverable: boolean
  health: ProductHealth
}

export interface ProductUiTask {
  id: string
  title: string
  status: ProductUiStatus
  progress: number
  providerId: ProviderId | 'unknown'
  rawError?: string
  presentedError?: PresentedError
  error?: PresentedError
  diagnosis?: ProductDiagnosis
  health?: ProductHealth
  traceId?: string
  createdAt: number
}

const uiStatuses: ProductUiStatus[] = ['waiting', 'active', 'paused', 'success', 'failed']
const healthValues: ProductHealth[] = ['stable', 'degraded', 'unstable']

function assertProductUiTask(task: ProductUiTask) {
  if (!uiStatuses.includes(task.status)) throw new Error(`Unknown product UI status: ${task.status}`)
  if (task.health && !healthValues.includes(task.health)) throw new Error(`Unknown product health: ${task.health}`)
  if (!task.id || !task.title || !task.providerId || typeof task.createdAt !== 'number') {
    throw new Error('Product UI task schema is incomplete')
  }
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
  const presentedError = presentTaskError(task)
  const normalized: ProductUiTask = {
    id: task.id,
    title: task.title || '未命名任务',
    status: mapTaskStatus(task.status),
    progress: clampProgress(task.progress),
    providerId: task.providerId || 'unknown',
    rawError: task.error,
    presentedError,
    error: presentedError,
    diagnosis: task.diagnosis,
    health: task.health || task.diagnosis?.health,
    traceId: task.traceId,
    createdAt: task.createdAt
  }
  assertProductUiTask(normalized)
  return normalized
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
