import type {
  ApiResponse,
  ProviderDownloadResult,
  ProviderId,
  ProviderListResult,
  ProviderShareResult,
  QuarkFile
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

export function resolveProviderResource(input: string, passcode: string, sessionId?: string) {
  return postJson<ProviderShareResult>('/api/providers/resolve', { input, passcode, sessionId })
}

export function listProviderFiles(
  providerId: ProviderId,
  shareId: string,
  stoken: string,
  dirFid?: string
) {
  return postJson<ProviderListResult>('/api/providers/list', { providerId, shareId, stoken, dirFid })
}

export function fetchProviderDownload(
  providerId: ProviderId,
  shareId: string,
  stoken: string,
  file: QuarkFile,
  sessionId?: string
) {
  return postJson<ProviderDownloadResult>('/api/providers/download', {
    providerId,
    shareId,
    stoken,
    file,
    sessionId
  })
}
