import { AppError } from '../../../http.js'
import { createAccessContext } from '../access/context.js'
import { buildBilibiliHeaders } from '../access/headers.js'
import { normalizeBiliEpisodes } from '../bilibiliNormalizer.js'
import type { ResolveShareOptions, ResolverAttempt, YtDlpInfo } from './types.js'
import { buildResolvedShare } from './utils.js'

/**
 * yt-dlp also uses the public pagelist endpoint to enumerate multi-P videos.
 * This is a metadata-only fallback; do not treat failed requests as a one-P playlist.
 */
export async function publicPageListResolver(inputUrl: string, options: ResolveShareOptions): Promise<ResolverAttempt> {
  const bvid = inputUrl.match(/(?:https?:\/\/)?(?:www\.)?bilibili\.com\/video\/(BV[0-9a-z]+)/i)?.[1]
  if (!bvid) return { ok: false, error: new Error('not a BV video') }

  try {
    const api = new URL('https://api.bilibili.com/x/player/pagelist')
    api.searchParams.set('bvid', bvid)
    const context = createAccessContext(inputUrl)
    const response = await fetch(api.toString(), {
      headers: buildBilibiliHeaders(context),
      signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) throw new AppError('bilibili_pagelist_failed', 'B站分P接口请求失败', 502)
    const payload = await response.json() as { code?: number; data?: unknown }
    if (payload.code !== 0 || !Array.isArray(payload.data)) {
      throw new AppError('bilibili_pagelist_failed', 'B站未返回可用的分P目录', 502)
    }
    const episodes = normalizeBiliEpisodes({ videoData: { bvid, pages: payload.data } } as YtDlpInfo)
    if (episodes.length < 2) {
      return { ok: false, error: new Error('not a multi-P video') }
    }
    return { ok: true, result: buildResolvedShare(inputUrl, episodes, 'page-list') }
  } catch (error) {
    return { ok: false, error }
  }
}
