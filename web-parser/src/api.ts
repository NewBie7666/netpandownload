import type { WebParseResult } from '../server/types'

interface ApiResponse<T> {
  ok: boolean
  result?: T
  error?: string
  message?: string
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await response.json() as ApiResponse<T>
  if (!response.ok || !data.ok || !data.result) {
    throw new Error(data.message || data.error || '请求失败')
  }
  return data.result
}

export function parseLink(input: string, passcode: string) {
  return postJson<WebParseResult>('/api/web/parse', { input, passcode })
}
