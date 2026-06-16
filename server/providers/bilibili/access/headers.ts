import type { AccessContext } from './context.js'
import { buildSignedFetchHeaders, buildSignedYtDlpArgs } from '../authContext/index.js'

function toAuthLikeContext(context: AccessContext) {
  return {
    episodeUrl: context.url,
    userAgent: context.userAgent,
    refererChain: context.refererChain || [context.referer],
    cookies: context.cookies,
    timingDelayMs: context.timingDelayMs || 0,
    episodeSessionId: context.episodeSessionId || context.url,
    acceptLanguage: context.acceptLanguage || 'zh-CN,zh;q=0.9',
    adaptiveLevel: 0 as const
  }
}

export function buildBilibiliHeaders(context: AccessContext) {
  return buildSignedFetchHeaders(toAuthLikeContext(context))
}

export function buildYtDlpHeaderArgs(context: AccessContext) {
  return buildSignedYtDlpArgs(toAuthLikeContext(context))
}
