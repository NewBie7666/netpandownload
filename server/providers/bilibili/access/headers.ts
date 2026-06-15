import type { AccessContext } from './context.js'

export function buildBilibiliHeaders(context: AccessContext) {
  const headers: Record<string, string> = {
    'User-Agent': context.userAgent,
    Referer: context.referer,
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }

  if (context.cookies) {
    headers.Cookie = context.cookies
  }

  return headers
}

export function buildYtDlpHeaderArgs(context: AccessContext) {
  const args = [
    '--user-agent',
    context.userAgent,
    '--add-header',
    `referer:${context.referer}`,
    '--add-header',
    'accept-language:zh-CN,zh;q=0.9'
  ]

  if (context.cookies) {
    args.push('--add-header', `cookie:${context.cookies}`)
  }

  return args
}
