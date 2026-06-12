import type {
  AddDownloadResult,
  AddDownloadRequest,
  ApiResponse,
  DownloadSettingsResult,
  DownloadTask,
  DownloadTasksResult,
  OpenDownloadDirResult,
  RemoveDownloadRequest
} from '../../shared/types'

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  const data = (await response.json()) as ApiResponse<T>

  if (!data.ok || !data.result) {
    throw new Error(data.message || data.error || 'Request failed')
  }

  return data.result
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = (await response.json()) as ApiResponse<T>

  if (!data.ok || !data.result) {
    throw new Error(data.message || data.error || 'Request failed')
  }

  return data.result
}

export function addDownloadTask(payload: AddDownloadRequest) {
  return postJson<AddDownloadResult>('/api/downloads/add', payload)
}

export function fetchDownloadTasks() {
  return getJson<DownloadTasksResult>('/api/downloads/active')
}

export function fetchDownloadSettings() {
  return getJson<DownloadSettingsResult>('/api/downloads/settings')
}

export function saveDownloadSettings(downloadDir: string) {
  return postJson<DownloadSettingsResult>('/api/downloads/settings', { downloadDir })
}

export function fetchDownloadTaskStatus(gid: string) {
  return getJson<DownloadTask>(`/api/downloads/status/${encodeURIComponent(gid)}`)
}

export function pauseDownloadTask(gid: string) {
  return postJson<{ gid: string }>(`/api/downloads/pause/${encodeURIComponent(gid)}`, {})
}

export function resumeDownloadTask(gid: string) {
  return postJson<{ gid: string }>(`/api/downloads/resume/${encodeURIComponent(gid)}`, {})
}

export function removeDownloadTask(gid: string, payload: RemoveDownloadRequest = {}) {
  return postJson<{ gid: string }>(`/api/downloads/remove/${encodeURIComponent(gid)}`, payload)
}

export function openDownloadDir() {
  return getJson<OpenDownloadDirResult>('/api/downloads/open-dir')
}
