import type { VideoItem, VideoPlayLine, VideoEpisode } from '../../shared/videoSources.js'
import { AppError } from '../http.js'

function plain(value: unknown, limit: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit)
}

function mediaKind(url: string, lineName: string): VideoEpisode['kind'] {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return 'unsupported'
    if (/\.m3u8$/i.test(parsed.pathname) || /m3u8/i.test(lineName)) return 'hls'
    if (/\.mp4$/i.test(parsed.pathname) || /^(mp4|direct)$/i.test(lineName)) return 'mp4'
  } catch { /* non-URL resolver/script token */ }
  return 'unsupported'
}

/** MacCMS vod_play_from and vod_play_url use $$$ groups and # episodes. */
export function parsePlayLines(from: unknown, playUrl: unknown): VideoPlayLine[] {
  const groups = plain(playUrl, 250_000).split('$$$').slice(0, 12)
  if (!plain(playUrl, 250_000)) return []
  const names = plain(from, 2000).split('$$$')
  return groups.map((group, groupIndex) => {
    const name = plain(names[groupIndex], 80) || '线路 ' + (groupIndex + 1)
    const episodes = group.split('#').slice(0, 250).flatMap((raw, index) => {
      const delimiter = raw.indexOf('$')
      const label = plain(delimiter >= 0 ? raw.slice(0, delimiter) : '', 100) || '第 ' + (index + 1) + ' 集'
      const url = plain(delimiter >= 0 ? raw.slice(delimiter + 1) : raw, 4096)
      if (!url) return []
      return [{ label, url, kind: mediaKind(url, name) }]
    })
    return { name, episodes }
  }).filter(line => line.episodes.length > 0)
}

export function parseMacCmsResponse(payload: unknown): {
  items: VideoItem[]
  page: number
  pageCount: number
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('video_source_bad_response', '影视源没有返回有效的 JSON 对象', 502)
  }
  const data = payload as Record<string, unknown>
  if (!Array.isArray(data.list)) {
    throw new AppError('video_source_bad_response', '影视源 JSON 缺少 list 数组（可能是 XML 或解析网页）', 502)
  }
  const items = data.list.slice(0, 100).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    const id = plain(row.vod_id, 100)
    const title = plain(row.vod_name, 180)
    if (!id || !title) return []
    const cover = plain(row.vod_pic, 2048)
    return [{
      id, title,
      ...(cover && /^https?:\/\//i.test(cover) ? { cover } : {}),
      remarks: plain(row.vod_remarks, 150),
      description: plain(row.vod_content, 2000).replace(/<[^>]*>/g, ''),
      lines: parsePlayLines(row.vod_play_from, row.vod_play_url)
    }]
  })
  const asPage = (v: unknown) => Number.isInteger(Number(v)) && Number(v) > 0 ? Math.min(99999, Number(v)) : 1
  return { items, page: asPage(data.page), pageCount: asPage(data.pagecount) }
}
