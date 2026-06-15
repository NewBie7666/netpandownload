import type { BiliEpisode } from '../bilibiliNormalizer.js'
import type { ResolverAttempt, YtDlpInfo } from './types.js'
import { asNumber, asString, buildResolvedShare, getArray, isRecord } from './utils.js'

function pickTitle(item: Record<string, unknown>, fallbackIndex: number) {
  return (
    asString(item.title) ||
    asString(item.long_title) ||
    asString(item.name) ||
    asString(item.show_title) ||
    `Bilibili Episode ${fallbackIndex}`
  )
}

function pickUrl(item: Record<string, unknown>, rootUrl: string) {
  return (
    asString(item.webpage_url) ||
    asString(item.url) ||
    asString(item.episode_url) ||
    asString(item.share_url) ||
    asString(item.link) ||
    rootUrl
  )
}

function pickId(item: Record<string, unknown>, fallback: string) {
  const raw =
    asString(item.id) ||
    asString(item.bvid) ||
    asString(item.aid) ||
    asString(item.cid) ||
    asString(item.ep_id) ||
    asString(item.episode_id) ||
    fallback
  return raw.replace(/[^0-9A-Za-z:_-]/g, '-')
}

function pushEpisode(
  episodes: Array<Omit<BiliEpisode, 'index'>>,
  item: Record<string, unknown>,
  rootUrl: string
) {
  const url = pickUrl(item, rootUrl)
  episodes.push({
    id: pickId(item, url || `episode-${episodes.length + 1}`),
    title: pickTitle(item, episodes.length + 1),
    url,
    duration: asNumber(item.duration),
    downloadInfo: item
  })
}

function collectBangumiEpisodes(raw: YtDlpInfo, rootUrl: string) {
  const data = isRecord(raw.data) ? raw.data : undefined
  const collected: Array<Omit<BiliEpisode, 'index'>> = []
  if (!data) return []

  for (const episode of getArray(data.episodes)) {
    pushEpisode(collected, episode, rootUrl)
  }

  for (const module of getArray(data.modules)) {
    for (const episode of getArray(module.episodes)) {
      pushEpisode(collected, episode, rootUrl)
    }
  }

  const seenUrls = new Set<string>()
  const unique: Array<Omit<BiliEpisode, 'index'>> = []
  for (const episode of collected) {
    if (!episode.url || seenUrls.has(episode.url)) continue
    seenUrls.add(episode.url)
    unique.push(episode)
  }

  return unique.map((episode, index) => ({
    ...episode,
    index: index + 1
  }))
}

export function bangumiResolver(inputUrl: string, raw?: YtDlpInfo): ResolverAttempt {
  if (!raw) return { ok: false, error: new Error('bangumi raw data missing') }

  const rootUrl = asString(raw.webpage_url) || asString(raw.url) || inputUrl
  const episodes = collectBangumiEpisodes(raw, rootUrl)
  if (!episodes.length) {
    return { ok: false, error: new Error('bangumi episodes missing') }
  }

  return {
    ok: true,
    result: buildResolvedShare(inputUrl, episodes, 'bangumi', raw)
  }
}
