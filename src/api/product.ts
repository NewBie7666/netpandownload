import type {
  ApiResponse,
  DownloadDashboard,
  DownloadHistoryResult,
  ProductTasksResult
} from '../../shared/types'

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
