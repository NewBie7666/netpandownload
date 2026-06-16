import { AppError } from '../../../http.js'
import { createAccessContext } from '../access/context.js'
import { throttleBilibiliRequest, toBilibiliFailSafeError, withBilibiliRetry } from '../stability/index.js'
import { resolvePlayUrlMedia } from './playUrlMedia.js'
import { runYtDlpMediaUrl } from './ytDlpMedia.js'
import type { BilibiliMediaResult, ResolveMediaOptions } from './types.js'

const mediaUrlTtlMs = 10 * 60 * 1000

async function resolveTemporaryMediaUrl(normalizedUrl: string, options: ResolveMediaOptions) {
  const accessContext = options.accessContext || createAccessContext(normalizedUrl)
  await throttleBilibiliRequest(accessContext.episodeSessionId || normalizedUrl)

  return withBilibiliRetry(async () => {
    try {
      return await resolvePlayUrlMedia(normalizedUrl, options.episodeInfo, accessContext)
    } catch {
      return runYtDlpMediaUrl(normalizedUrl, { ...options, accessContext })
    }
  })
}

export async function resolveMedia(episodeUrl: string, options: ResolveMediaOptions = {}): Promise<BilibiliMediaResult> {
  const normalizedUrl = String(episodeUrl || '').trim()
  if (!normalizedUrl) {
    throw new AppError('media_resolution_failed', 'B站单集地址为空，无法解析媒体直链')
  }

  try {
    const url = await resolveTemporaryMediaUrl(normalizedUrl, options)
    return {
      url,
      expiresAt: new Date(Date.now() + mediaUrlTtlMs).toISOString()
    }
  } catch (error) {
    throw toBilibiliFailSafeError(error, 'media')
  }
}
