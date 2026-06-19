import type { BiliEpisode } from '../bilibiliNormalizer.js'
import type { ResolverAttempt, YtDlpInfo } from './types.js'
import { buildResolvedShare, getArray, isRecord, asString, asNumber } from './utils.js'

function isSpaceSearchUrl(inputUrl: string) {
  try {
    const url = new URL(inputUrl)
    return /^space\.bilibili\.com$/i.test(url.hostname) && /^\/\d+\/search\/?$/i.test(url.pathname)
  } catch {
    return false
  }
}

function titleFromItem(item: Record<string, unknown>, fallback: number) {
  return (
    asString(item.title).replace(/<[^>]+>/g, '') ||
    asString(item.name) ||
    asString(item.desc) ||
    `Bilibili Space Video ${fallback}`
  )
}

function episodeFromItem(item: Record<string, unknown>, index: number): Omit<BiliEpisode, 'index'> | undefined {
  const bvid = asString(item.bvid) || asString(item.bv_id)
  if (!bvid) return undefined

  return {
    id: bvid.replace(/[^0-9A-Za-z:_-]/g, '-'),
    title: titleFromItem(item, index),
    url: `https://www.bilibili.com/video/${bvid}`,
    duration: asNumber(item.duration),
    downloadInfo: item
  }
}

function collectFromObject(root: Record<string, unknown>, output: Array<Omit<BiliEpisode, 'index'>>) {
  for (const key of ['vlist', 'list', 'result', 'items', 'archives']) {
    for (const item of getArray(root[key])) {
      const episode = episodeFromItem(item, output.length + 1)
      if (episode) output.push(episode)
      collectFromObject(item, output)
    }
  }

  for (const child of Object.values(root)) {
    if (isRecord(child)) collectFromObject(child, output)
  }
}

export function spaceSearchResolver(inputUrl: string, raw?: YtDlpInfo): ResolverAttempt {
  if (!isSpaceSearchUrl(inputUrl) || !raw || !isRecord(raw)) {
    return { ok: false, error: new Error('space search data missing') }
  }

  const collected: Array<Omit<BiliEpisode, 'index'>> = []
  collectFromObject(raw, collected)

  const seen = new Set<string>()
  const episodes = collected
    .filter((episode) => {
      if (!episode.url || seen.has(episode.url)) return false
      seen.add(episode.url)
      return true
    })
    .map((episode, index) => ({ ...episode, index: index + 1 }))

  if (!episodes.length) {
    return { ok: false, error: new Error('space search episodes missing') }
  }

  return {
    ok: true,
    result: buildResolvedShare(inputUrl, episodes, 'space-search', raw)
  }
}
