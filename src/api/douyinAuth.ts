import type { DouyinAuthStatus } from '../../shared/douyinAuth'

interface DouyinApiResponse<T> {
  ok?: boolean
  result?: T
  message?: string
  error?: string
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers || {})
    }
  })
  const data = (await response.json().catch(() => null)) as DouyinApiResponse<T> | null

  if (!response.ok || !data?.ok || data.result === undefined) {
    throw new Error(data?.message || data?.error || '抖音登录请求失败')
  }

  return data.result
}

export function fetchDouyinAuthStatus(sessionId?: string, signal?: AbortSignal) {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  return requestJson<DouyinAuthStatus>(`/api/auth/douyin/status${query}`, {
    cache: 'no-store',
    signal
  })
}

export function startDouyinQrLogin(force = false, signal?: AbortSignal) {
  return requestJson<DouyinAuthStatus>('/api/auth/douyin/qr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
    signal
  })
}

export function logoutDouyin(signal?: AbortSignal) {
  return requestJson<DouyinAuthStatus>('/api/auth/douyin/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal
  })
}
