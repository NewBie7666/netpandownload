import { createHash } from 'node:crypto'
import { getAdaptiveParams } from '../adaptive/index.js'
import { normalizeBiliUrl } from '../resolver/index.js'
import { getBilibiliRequestProfile } from './profileManager.js'

export interface AuthContext {
  episodeUrl: string
  userAgent: string
  refererChain: string[]
  cookies?: string
  timingDelayMs: number
  episodeSessionId: string
  acceptLanguage: string
  adaptiveLevel: 0 | 1 | 2
}

const bucketMs = 15 * 60 * 1000
const stableBaseDelayMs = 300

function stableHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function getTimeBucket(now = Date.now()) {
  return Math.floor(now / bucketMs)
}

function buildRefererChain(url: string, baseReferer: string) {
  const normalizedUrl = normalizeBiliUrl(url)
  if (/\/bangumi\/play\//i.test(normalizedUrl)) {
    return [baseReferer, normalizedUrl]
  }
  if (/\/video\/BV/i.test(normalizedUrl)) {
    return [baseReferer, normalizedUrl]
  }
  return [baseReferer]
}

export function buildAuthContext(episodeUrl: string): AuthContext {
  const profile = getBilibiliRequestProfile()
  const normalizedUrl = normalizeBiliUrl(String(episodeUrl || '').trim())
  const cookies = String(process.env.BILIBILI_COOKIE || '').trim()
  const episodeSessionId = stableHash(`${normalizedUrl}:${getTimeBucket()}`)
  const adaptiveParams = getAdaptiveParams(episodeSessionId)

  return {
    episodeUrl: normalizedUrl,
    userAgent: profile.userAgent,
    acceptLanguage: profile.acceptLanguage,
    refererChain: buildRefererChain(normalizedUrl, profile.baseReferer),
    cookies: cookies || undefined,
    timingDelayMs: stableBaseDelayMs + adaptiveParams.timingJitterMs,
    episodeSessionId,
    adaptiveLevel: adaptiveParams.adaptiveLevel
  }
}
