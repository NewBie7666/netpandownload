import type { ApiResponse, DownloadDecision } from '../../shared/types'

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await response.json() as ApiResponse<T>
  if (!response.ok || !data.ok || !data.result) {
    throw new Error(data.message || data.error || '决策请求失败')
  }
  return data.result
}

export function resolveDownloadDecision(url: string) {
  return postJson<DownloadDecision>('/api/decision/resolve', { url })
}
