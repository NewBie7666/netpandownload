import type {
  ApiResponse,
  DownloadResult,
  ListResult,
  QuarkAuthQrcodeResult,
  QuarkAuthStatusResult,
  QuarkFile,
  ShareResult
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
    throw new Error(data.message || data.error || '请求失败')
  }

  return data.result
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = (await response.json()) as ApiResponse<T>

  if (!data.ok || !data.result) {
    throw new Error(data.message || data.error || '请求失败')
  }

  return data.result
}

export function fetchShareFiles(shareUrl: string, passcode: string) {
  return postJson<ShareResult>('/api/quark/share', { shareUrl, passcode })
}

export function fetchFolderFiles(shareId: string, stoken: string, dirFid?: string) {
  return postJson<ListResult>('/api/quark/list', { shareId, stoken, dirFid })
}

export function fetchDownloadUrl(
  shareId: string,
  stoken: string,
  file: QuarkFile,
  sessionId?: string
) {
  return postJson<DownloadResult>('/api/quark/download', { shareId, stoken, file, sessionId })
}

export function createQuarkAuthQrcode() {
  return postJson<QuarkAuthQrcodeResult>('/api/quark/auth/qrcode', {})
}

export function fetchQuarkAuthStatus(sessionId: string) {
  return getJson<QuarkAuthStatusResult>(
    `/api/quark/auth/status?sessionId=${encodeURIComponent(sessionId)}`
  )
}

export function logoutQuarkAuth(sessionId: string) {
  return postJson<{ loggedOut: boolean }>('/api/quark/auth/logout', { sessionId })
}
