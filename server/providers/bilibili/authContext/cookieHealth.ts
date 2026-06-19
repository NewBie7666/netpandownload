import { clearRuntimeCookie, getCookie } from '../auth/envBridge.js'
import { buildAuthContext } from './contextBuilder.js'
import { buildSignedFetchHeaders } from './requestSigner.js'

export type CookieHealthStatus = 'valid' | 'expired' | 'invalid' | 'unknown'

export interface CookieHealthResult {
  status: CookieHealthStatus
  reason?: string
}

const probeUrl = 'https://api.bilibili.com/x/web-interface/nav'
let cachedProbe: { result: CookieHealthResult; checkedAt: number } | null = null
const probeCacheMs = 60 * 1000

export function isValidCookieStructure(cookie = getCookie()) {
  return /\bSESSDATA=/.test(cookie) && /\bDedeUserID=/.test(cookie)
}

export function markCookieInvalid(reason = 'cookie invalid') {
  clearRuntimeCookie()
  cachedProbe = {
    result: { status: 'invalid', reason },
    checkedAt: Date.now()
  }
}

export async function cookieHealthProbe(force = false): Promise<CookieHealthResult> {
  const cookie = getCookie()
  if (!isValidCookieStructure(cookie)) {
    markCookieInvalid('cookie structure is incomplete')
    return { status: 'invalid', reason: 'cookie structure is incomplete' }
  }

  const now = Date.now()
  if (!force && cachedProbe && now - cachedProbe.checkedAt < probeCacheMs) {
    return cachedProbe.result
  }

  try {
    const context = buildAuthContext(probeUrl)
    const response = await fetch(probeUrl, {
      method: 'GET',
      headers: buildSignedFetchHeaders(context),
      signal: AbortSignal.timeout(5000)
    })

    if (response.status === 401 || response.status === 403) {
      markCookieInvalid(`cookie probe rejected: ${response.status}`)
      return { status: 'invalid', reason: `cookie probe rejected: ${response.status}` }
    }
    if (response.status === 412 || response.status === 429) {
      cachedProbe = {
        result: { status: 'unknown', reason: `cookie probe blocked: ${response.status}` },
        checkedAt: now
      }
      return cachedProbe.result
    }
    if (!response.ok) {
      cachedProbe = {
        result: { status: 'unknown', reason: `cookie probe failed: ${response.status}` },
        checkedAt: now
      }
      return cachedProbe.result
    }

    const payload = (await response.json()) as { code?: number; message?: string }
    if (payload.code === -101 || payload.code === -400) {
      markCookieInvalid(payload.message || 'cookie probe returned invalid login state')
      return { status: 'invalid', reason: payload.message || 'cookie probe returned invalid login state' }
    }

    cachedProbe = {
      result: { status: 'valid' },
      checkedAt: now
    }
    return cachedProbe.result
  } catch {
    cachedProbe = {
      result: { status: 'unknown', reason: 'cookie probe network error' },
      checkedAt: now
    }
    return cachedProbe.result
  }
}

export function getCachedCookieHealth(): CookieHealthResult {
  if (!isValidCookieStructure()) return { status: 'invalid', reason: 'cookie structure is incomplete' }
  return cachedProbe?.result || { status: 'unknown' }
}
