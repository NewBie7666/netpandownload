import type { ResolveShareOptions, ResolverAttempt } from './types.js'
import { buildResolvedShare, normalizeBiliUrl, singleEpisodeFromUrl } from './utils.js'

function isB23Url(inputUrl: string) {
  try {
    return /^b23\.tv$/i.test(new URL(inputUrl).hostname)
  } catch {
    return false
  }
}

export async function heuristicResolver(inputUrl: string, options: ResolveShareOptions = {}): Promise<ResolverAttempt> {
  try {
    let resolvedUrl = normalizeBiliUrl(inputUrl)
    if (isB23Url(resolvedUrl) && options.expandShortUrl) {
      resolvedUrl = normalizeBiliUrl(await options.expandShortUrl(resolvedUrl))
    }

    const episodes = singleEpisodeFromUrl(resolvedUrl)
    return {
      ok: true,
      result: buildResolvedShare(resolvedUrl, episodes, 'heuristic')
    }
  } catch (error) {
    return { ok: false, error }
  }
}
