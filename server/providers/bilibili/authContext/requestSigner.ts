import type { AuthContext } from './contextBuilder.js'

export function getPrimaryReferer(context: AuthContext) {
  return context.refererChain[context.refererChain.length - 1] || 'https://www.bilibili.com'
}

export function buildSignedFetchHeaders(context: AuthContext) {
  const headers: Record<string, string> = {
    'User-Agent': context.userAgent,
    Referer: getPrimaryReferer(context),
    'Accept-Language': context.acceptLanguage
  }

  if (context.cookies) {
    headers.Cookie = context.cookies
  }

  return headers
}

export function buildSignedYtDlpArgs(context: AuthContext) {
  const args = [
    '--user-agent',
    context.userAgent,
    '--add-header',
    `referer:${getPrimaryReferer(context)}`,
    '--add-header',
    `accept-language:${context.acceptLanguage}`
  ]

  if (context.cookies) {
    args.push('--add-header', `cookie:${context.cookies}`)
  }

  return args
}
