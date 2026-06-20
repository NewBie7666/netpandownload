import { OPAQUE_ACTIONS } from './toolRouter'
import type { OpaqueActionContext, OpaqueActionToken } from './types'

function quoteForCommand(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`
}

export async function executeOpaqueAction(token: OpaqueActionToken, context: OpaqueActionContext) {
  const cleanUrl = context.url.trim()
  if (!cleanUrl) return

  if (token === OPAQUE_ACTIONS.openDesktop) {
    context.openUrl(`netpan://action?type=download&url=${encodeURIComponent(cleanUrl)}`)
    return
  }

  if (token === OPAQUE_ACTIONS.copyCommand) {
    await context.copyText(`yt-dlp ${quoteForCommand(cleanUrl)}`, '命令已复制')
    return
  }

  await context.copyText(cleanUrl, '链接已复制')
}
