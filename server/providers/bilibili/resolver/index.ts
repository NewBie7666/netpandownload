import { AppError } from '../../../http.js'
import { bangumiResolver } from './bangumiResolver.js'
import { heuristicResolver } from './heuristicResolver.js'
import { publicPageListResolver } from './publicPageListResolver.js'
import { spaceSearchResolver } from './spaceSearchResolver.js'
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

function isSpaceSearchInput(inputUrl: string) {
  try {
    const url = new URL(inputUrl)
    return /^space\.bilibili\.com$/i.test(url.hostname) && /^\/\d+\/search\/?$/i.test(url.pathname)
  } catch { return false }
}

function isVideoInput(inputUrl: string) {
  try {
    const url = new URL(inputUrl)
    return /^(www\.)?bilibili\.com$/i.test(url.hostname) && /^\/video\/BV[0-9a-z]+\/?$/i.test(url.pathname)
  } catch { return false }
}

function requestedPart(inputUrl: string): number | undefined {
  try {
    const value = Number(new URL(inputUrl).searchParams.get('p') || '')
    return Number.isInteger(value) && value > 0 ? value : undefined
  } catch { return undefined }
}

function addCandidate(candidates: StableResolvedShare[], result?: StableResolvedShare) {
  if (consistent(result)) candidates.push(result as StableResolvedShare)
}

export async function resolveShare(inputUrl: string, options: ResolveShareOptions = {}): Promise<StableResolvedShare> {
  let raw: YtDlpInfo | undefined
  if (options.runYtDlpJson) {
    try { raw = await options.runYtDlpJson(inputUrl) } catch { raw = undefined }
  }

  const candidates: StableResolvedShare[] = []
  if (raw) {
    addCandidate(candidates, bangumiResolver(inputUrl, raw).result)
    addCandidate(candidates, spaceSearchResolver(inputUrl, raw).result)
    const extracted = await ytDlpResolver(inputUrl, {
      ...options, runYtDlpJson: async () => raw as YtDlpInfo
    })
    addCandidate(candidates, extracted.result)
  }

  // HTML initial state may include UGC season and multi-P pages missing in yt-dlp's
  // single-video JSON. Do not return a one-entry result before trying these sources.
  if (options.fetchInitialStateJson && (isVideoInput(inputUrl) || !candidates.some(c => c.episodes.length > 1))) {
    try {
      const htmlRaw = await options.fetchInitialStateJson(inputUrl)
      const htmlSpace = spaceSearchResolver(inputUrl, htmlRaw)
      if (consistent(htmlSpace.result)) {
        addCandidate(candidates, htmlSpace.result)
      } else {
        addCandidate(candidates, bangumiResolver(inputUrl, htmlRaw).result)
        const html = await ytDlpResolver(inputUrl, {
          ...options, runYtDlpJson: async () => htmlRaw
        })
        if (html.result) addCandidate(candidates, { ...html.result, source: 'html' })
      }
    } catch { /* use other resolvers */ }
  }

  // The stable public page listing returns page, part and CID for every BV multi-P part.
  if (isVideoInput(inputUrl) && !candidates.some(c => c.episodes.length > 1)) {
    const pageList = await publicPageListResolver(inputUrl)
    addCandidate(candidates, pageList.result)
  }

  // Prefer the most complete list rather than the first resolver to return a single item.
  candidates.sort((a, b) => b.episodes.length - a.episodes.length)
  if (candidates.length > 0) {
    const best = candidates[0]
    if (best.episodes.length > 1) return best
    if (!isVideoInput(inputUrl) || !requestedPart(inputUrl) || requestedPart(inputUrl) === 1) {
      return best
    }
  }

  if (isSpaceSearchInput(inputUrl)) {
    throw new AppError('bilibili_resolve_failed', 'Bilibili space search resolve failed; login or upstream access may be required')
  }

  // A link to P9 cannot be truthfully represented by a fabricated Episode 1.
  if (isVideoInput(inputUrl) && (requestedPart(inputUrl) || 0) > 1) {
    throw new AppError('bilibili_playlist_incomplete', '无法获取完整分P/合集列表，请确认视频可访问或登录 B站后重试', 502)
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
  normalizeBiliEpisodeUrl,
  toStableCacheKey
} from './utils.js'
