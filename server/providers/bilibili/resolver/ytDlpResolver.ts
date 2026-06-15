import { normalizeBiliEpisodes } from '../bilibiliNormalizer.js'
import type { ResolveShareOptions, ResolverAttempt } from './types.js'
import { buildResolvedShare } from './utils.js'

export async function ytDlpResolver(inputUrl: string, options: ResolveShareOptions): Promise<ResolverAttempt> {
  if (!options.runYtDlpJson) {
    return { ok: false, error: new Error('yt-dlp runner missing') }
  }

  try {
    const raw = await options.runYtDlpJson(inputUrl)
    const episodes = normalizeBiliEpisodes(raw)
    if (!episodes.length) {
      return { ok: false, error: new Error('yt-dlp episodes missing') }
    }

    return {
      ok: true,
      result: buildResolvedShare(inputUrl, episodes, 'yt-dlp', raw)
    }
  } catch (error) {
    return { ok: false, error }
  }
}
