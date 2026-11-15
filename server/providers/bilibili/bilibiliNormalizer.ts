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
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function pickBvid(item: UnknownRecord) {
  const arc = isRecord(item.arc) ? item.arc : undefined
  return asString(item.bvid) || (arc ? asString(arc.bvid) : '')
}

function bvidFromUrl(url: string) {
  return url.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || ''
}

function pageNumber(item: UnknownRecord): number | undefined {
  const number = asNumber(item.page) || asNumber(item.page_number) || asNumber(item.part_number)
  if (number && Number.isInteger(number) && number > 0) return number
  const text = asString(item.webpage_url) || asString(item.episode_url) || ''
  try {
    const p = Number(new URL(text).searchParams.get('p') || '')
    if (p > 0 && Number.isInteger(p)) return p
  } catch { /* no valid webpage URL */ }
  return undefined
}

function pickTitle(item: UnknownRecord, fallbackIndex: number) {
  const arc = isRecord(item.arc) ? item.arc : undefined
  const page = isRecord(item.page) ? item.page : undefined
  return (
    asString(item.title) ||
    (page ? asString(page.part) : '') ||
    asString(item.part) ||
    (arc ? asString(arc.title) : '') ||
    asString(item.long_title) ||
    asString(item.name) ||
    asString(item.show_title) ||
    'Bilibili Episode ' + fallbackIndex
  )
}

function pickUrl(item: UnknownRecord, rootUrl: string) {
  const explicitPage = asString(item.webpage_url) || asString(item.episode_url) ||
    asString(item.share_url) || asString(item.link)
  if (explicitPage) return explicitPage

  const bvid = pickBvid(item) || bvidFromUrl(rootUrl)
  if (bvid) {
    const p = pageNumber(item)
    return 'https://www.bilibili.com/video/' + bvid + (p ? '?p=' + p : '')
  }
  return asString(item.url) || rootUrl
}

function pickId(item: UnknownRecord, fallback: string, url: string) {
  const bvid = pickBvid(item) || bvidFromUrl(url)
  const p = pageNumber(item)
  if (bvid && p) return bvid + '-p' + p
  const arc = isRecord(item.arc) ? item.arc : undefined
  const value = bvid || asString(item.id) || (arc ? asString(arc.bvid) : '') ||
    String(item.cid || item.ep_id || item.episode_id || fallback)
  return value.replace(/[^0-9A-Za-z:_-]/g, '-')
}

function pushEpisode(episodes: Array<Omit<BiliEpisode, 'index'>>, item: UnknownRecord, rootUrl: string) {
  const url = pickUrl(item, rootUrl)
  episodes.push({
    id: pickId(item, url || 'episode-' + (episodes.length + 1), url),
    title: pickTitle(item, episodes.length + 1),
    url,
    duration: asNumber(item.duration),
    downloadInfo: item
  })
}

function collectEntries(episodes: Array<Omit<BiliEpisode, 'index'>>, entries: UnknownRecord[], rootUrl: string) {
  for (const entry of entries) {
    const nested = getArray(entry.entries)
    if (nested.length) {
      collectEntries(episodes, nested, pickUrl(entry, rootUrl))
      continue
    }
    pushEpisode(episodes, entry, rootUrl)
  }
}

function collectBangumi(root: UnknownRecord, rootUrl: string) {
  const episodes: Array<Omit<BiliEpisode, 'index'>> = []
  const data = isRecord(root.data) ? root.data : undefined
  if (data) {
    collectEntries(episodes, getArray(data.episodes), rootUrl)
    for (const module of getArray(data.modules)) {
      collectEntries(episodes, getArray(module.episodes), rootUrl)
    }
  }
  return episodes
}

function collectUgcSeason(root: UnknownRecord, rootUrl: string) {
  const episodes: Array<Omit<BiliEpisode, 'index'>> = []
  const videoData = isRecord(root.videoData) ? root.videoData : undefined
  const data = isRecord(root.data) ? root.data : undefined
  const sectionsInfo = isRecord(root.sectionsInfo) ? root.sectionsInfo : undefined

  const seasonCandidates = [root.ugc_season, videoData?.ugc_season, data?.ugc_season]
    .filter(isRecord)
  for (const season of seasonCandidates) {
    for (const section of getArray(season.sections)) {
      collectEntries(episodes, getArray(section.episodes), rootUrl)
    }
  }
  if (sectionsInfo) {
    for (const section of getArray(sectionsInfo.sections)) {
      collectEntries(episodes, getArray(section.episodes), rootUrl)
    }
  }
  return episodes
}

function collectVideoPages(root: UnknownRecord, rootUrl: string) {
  const episodes: Array<Omit<BiliEpisode, 'index'>> = []
  const videoData = isRecord(root.videoData) ? root.videoData : undefined
  const data = isRecord(root.data) ? root.data : undefined
  const video = videoData || data || root
  const pages = getArray(video.pages)
  const bvid = asString(video.bvid) || asString(root.bvid) || bvidFromUrl(rootUrl)
  if (!bvid || !pages.length) return episodes
  const videoTitle = asString(video.title) || asString(root.title) || bvid

  pages.forEach((page, index) => {
    const p = asNumber(page.page) || index + 1
    const cid = asNumber(page.cid)
    const part = asString(page.part) || '第 ' + p + ' P'
    episodes.push({
      id: bvid + '-p' + p,
      title: videoTitle + ' · P' + p + ' ' + part,
      url: 'https://www.bilibili.com/video/' + bvid + '?p=' + p,
      duration: asNumber(page.duration),
      // Keep each page's CID; never let the first page CID leak into later parts.
      downloadInfo: { bvid, cid, page: { cid }, partNumber: p }
    })
  })
  return episodes
}

function uniqueEpisodes(episodes: Array<Omit<BiliEpisode, 'index'>>): BiliEpisode[] {
  const seen = new Set<string>()
  return episodes.filter((episode) => {
    if (!episode.url) return false
    const key = episode.url.replace(/#.*$/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((episode, index) => ({ ...episode, index: index + 1 }))
}

export function normalizeBiliEpisodes(raw: unknown): BiliEpisode[] {
  if (!isRecord(raw)) return []
  const video = isRecord(raw.videoData) ? raw.videoData : undefined
  const rootUrl = asString(raw.webpage_url) || asString(video?.webpage_url) ||
    (asString(video?.bvid) ? 'https://www.bilibili.com/video/' + video?.bvid : '') ||
    asString(raw.url)

  const playlist: Array<Omit<BiliEpisode, 'index'>> = []
  collectEntries(playlist, getArray(raw.entries), rootUrl)
  const bangumi = collectBangumi(raw, rootUrl)
  const season = collectUgcSeason(raw, rootUrl)
  const pages = collectVideoPages(raw, rootUrl)

  // Never let a one-entry yt-dlp/media response mask a full page/season listing.
  for (const candidates of [bangumi, season, playlist, pages]) {
    const normalized = uniqueEpisodes(candidates)
    if (normalized.length > 1) return normalized
  }

  const videoData = isRecord(raw.videoData) ? raw.videoData : undefined
  const fallback = videoData && Object.keys(videoData).length ? videoData : raw
  const candidates = [bangumi, season, playlist, pages].flat()
  if (candidates.length) return uniqueEpisodes(candidates)
  const single: Array<Omit<BiliEpisode, 'index'>> = []
  pushEpisode(single, fallback, rootUrl)
  return uniqueEpisodes(single)
}
