import { AppError } from '../../../http.js'
import { bangumiResolver } from './bangumiResolver.js'
import { heuristicResolver } from './heuristicResolver.js'
import type { ResolveShareOptions, StableResolvedShare, YtDlpInfo } from './types.js'
import { assertEpisodeConsistency } from './utils.js'
import { ytDlpResolver } from './ytDlpResolver.js'

function consistent(result?: StableResolvedShare) {
  if (!result) return false
  try {
    assertEpisodeConsistency(result)
    return result.episodes.length > 0
  } catch {
    return false
  }
}

export async function resolveShare(inputUrl: string, options: ResolveShareOptions = {}): Promise<StableResolvedShare> {
  let raw: YtDlpInfo | undefined

  if (options.runYtDlpJson) {
    try {
      raw = await options.runYtDlpJson(inputUrl)
    } catch {
      raw = undefined
    }
  }

  const bangumi = bangumiResolver(inputUrl, raw)
  if (consistent(bangumi.result)) return bangumi.result as StableResolvedShare

  if (raw) {
    const ytDlp = await ytDlpResolver(inputUrl, { ...options, runYtDlpJson: async () => raw as YtDlpInfo })
    if (consistent(ytDlp.result)) return ytDlp.result as StableResolvedShare
  }

  const heuristic = await heuristicResolver(inputUrl, options)
  if (consistent(heuristic.result)) return heuristic.result as StableResolvedShare

  throw new AppError('bilibili_resolve_failed', 'Bilibili resolve failed; fallback to single video mode')
}

export * from './types.js'
export {
  assertEpisodeConsistency,
  cacheTtlMs,
  isBilibiliUrl,
  normalizeBiliUrl,
  toStableCacheKey
} from './utils.js'
