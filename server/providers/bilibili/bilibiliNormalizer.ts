export interface BiliEpisode {
  id: string
  title: string
  url: string
  index: number
  duration?: number
  downloadInfo?: unknown
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function pickTitle(item: UnknownRecord, fallbackIndex: number) {
  return (
    asString(item.title) ||
    asString(item.long_title) ||
    asString(item.name) ||
    asString(item.part) ||
    asString(item.show_title) ||
    `Bilibili Episode ${fallbackIndex}`
  )
}

function pickUrl(item: UnknownRecord, rootUrl = '') {
  return (
    asString(item.webpage_url) ||
    asString(item.url) ||
    asString(item.episode_url) ||
    asString(item.share_url) ||
    asString(item.link) ||
    rootUrl
  )
}

function pickId(item: UnknownRecord, fallback: string) {
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
  item: UnknownRecord,
  rootUrl: string
) {
  const url = pickUrl(item, rootUrl)
  const id = pickId(item, url || `episode-${episodes.length + 1}`)
  episodes.push({
    id,
    title: pickTitle(item, episodes.length + 1),
    url,
    duration: asNumber(item.duration),
    downloadInfo: item
  })
}

function collectEntries(
  episodes: Array<Omit<BiliEpisode, 'index'>>,
  entries: UnknownRecord[],
  rootUrl: string
) {
  for (const entry of entries) {
    const nested = getArray(entry.entries)
    if (nested.length) {
      collectEntries(episodes, nested, pickUrl(entry, rootUrl))
      continue
    }
    pushEpisode(episodes, entry, rootUrl)
  }
}

function collectBangumiEpisodes(
  episodes: Array<Omit<BiliEpisode, 'index'>>,
  root: UnknownRecord,
  rootUrl: string
) {
  const data = isRecord(root.data) ? root.data : undefined
  if (!data) return

  collectEntries(episodes, getArray(data.episodes), rootUrl)

  for (const module of getArray(data.modules)) {
    collectEntries(episodes, getArray(module.episodes), rootUrl)
  }
}

export function normalizeBiliEpisodes(ytdlpJson: unknown): BiliEpisode[] {
  if (!isRecord(ytdlpJson)) return []

  const rootUrl = pickUrl(ytdlpJson)
  const collected: Array<Omit<BiliEpisode, 'index'>> = []
  collectEntries(collected, getArray(ytdlpJson.entries), rootUrl)
  collectBangumiEpisodes(collected, ytdlpJson, rootUrl)

  if (!collected.length) {
    pushEpisode(collected, ytdlpJson, rootUrl)
  }

  const seen = new Set<string>()
  const unique: Array<Omit<BiliEpisode, 'index'>> = []
  for (const episode of collected) {
    const key = episode.url || episode.id
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(episode)
  }

  return unique.map((episode, index) => ({
    ...episode,
    index: index + 1
  }))
}
