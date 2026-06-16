import { bindEpisodeAuthContext, getPrimaryReferer } from '../authContext/index.js'

export interface AccessContext {
  url: string
  userAgent: string
  referer: string
  cookies?: string
  retryCount: number
  acceptLanguage: string
  episodeSessionId: string
  timingDelayMs: number
  refererChain: string[]
}

export function createAccessContext(url: string, retryCount = 0): AccessContext {
  const context = bindEpisodeAuthContext(url)
  return {
    url: context.episodeUrl,
    userAgent: context.userAgent,
    referer: getPrimaryReferer(context),
    cookies: context.cookies,
    retryCount,
    acceptLanguage: context.acceptLanguage,
    episodeSessionId: context.episodeSessionId,
    timingDelayMs: context.timingDelayMs,
    refererChain: context.refererChain
  }
}
