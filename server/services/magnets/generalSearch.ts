import { AppError } from '../../http.js'
import { registerAllowedDownloadUrl } from '../../downloader/downloadService.js'
import { normalizeMagnetKeyword } from './keywordSearch.js'

export type GeneralSourceId = 'bitsearch' | 'nyaa' | 'academic'
export type GeneralCategory = 'all' | 'movie' | 'tv' | 'book' | 'anime' | 'learning'
export interface GeneralMagnetItem {
  hash: string
  title: string
  size: string
  magnet: string
  source: GeneralSourceId
  category: string
  seeders: number | null
}
export interface SourceStatus {
  id: GeneralSourceId
  name: string
  ok: boolean
  count: number
  error?: string
}
export interface GeneralSearchResult {
  query: string
  category: GeneralCategory
  source: string
  items: GeneralMagnetItem[]
  sources: SourceStatus[]
}

const SOURCE_NAMES: Record<GeneralSourceId, string> = {
  bitsearch: 'BitSearch', nyaa: 'Nyaa', academic: 'Academic Torrents'
}
const SOURCE_IDS: GeneralSourceId[] = ['bitsearch', 'nyaa', 'academic']
const CACHE_MS = 5 * 60 * 1000
const cache = new Map<string, { expires: number; result: GeneralSearchResult }>()

export function normalizeGeneralCategory(value: unknown): GeneralCategory {
  if (value === undefined || value === 'all') return 'all'
  if (value === 'movie' || value === 'tv' || value === 'book' || value === 'anime' || value === 'learning') return value
  throw new AppError('invalid_category', '不支持的资源分类')
}
export function normalizeGeneralSource(value: unknown): GeneralSourceId | 'all' {
  if (value === undefined || value === 'all') return 'all'
  if (typeof value === 'string' && SOURCE_IDS.includes(value as GeneralSourceId)) return value as GeneralSourceId
  throw new AppError('invalid_source', '不支持的磁力搜索源')
}

function sizeLabel(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
  if (value >= 1024 ** 4) return (value / (1024 ** 4)).toFixed(2) + ' TB'
  if (value >= 1024 ** 3) return (value / (1024 ** 3)).toFixed(2) + ' GB'
  if (value >= 1024 ** 2) return (value / (1024 ** 2)).toFixed(1) + ' MB'
  if (value >= 1024) return (value / 1024).toFixed(1) + ' KB'
  return value.toFixed(0) + ' B'
}
function knownSeeders(value: unknown): number | null {
  if (value === '' || value == null) return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result >= 0 ? result : null
}
export function createGeneralItem(
  hash: unknown, title: unknown, source: GeneralSourceId, category: unknown,
  size = '', seeders: number | null = null
): GeneralMagnetItem | null {
  if (typeof hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(hash) ||
      typeof title !== 'string' || !title.trim()) return null
  const name = title.trim().slice(0, 240)
  const cleanHash = hash.toLowerCase()
  return { hash: cleanHash, title: name, source, category: typeof category === 'string' ? category.slice(0, 60) : '',
    size, seeders, magnet: 'magnet:?xt=urn:btih:' + cleanHash + '&dn=' + encodeURIComponent(name) }
}
function decodeXml(text: string): string {
  return text.trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, v: string) => String.fromCodePoint(parseInt(v, 16)))
    .replace(/&#(\d{1,7});/g, (_, v: string) => String.fromCodePoint(Math.min(0x10ffff, Number(v))))
}
function xmlTag(xml: string, tag: string): string {
  // All tag names are hardcoded by this module, not provided by the user.
  return decodeXml(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(xml)?.[1] || '')
}

export function parseBitSearchJson(payload: unknown): GeneralMagnetItem[] {
  if (!payload || typeof payload !== 'object') throw new Error('BitSearch 返回的数据格式不正确')
  const value = payload as { success?: boolean; results?: unknown }
  if (value.success === false || !Array.isArray(value.results)) throw new Error('BitSearch 没有返回有效的搜索列表')
  const results: GeneralMagnetItem[] = []
  for (const raw of value.results) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const category = String(row.category || '')
    if (row.category === 10 || /adult|xxx|porn|情色|成人/i.test(category)) continue
    const item = createGeneralItem(row.infohash, row.title, 'bitsearch', category,
      sizeLabel(row.size), knownSeeders(row.seeders))
    if (item) results.push(item)
  }
  return results
}
export function parseNyaaRss(xml: string): GeneralMagnetItem[] {
  const result: GeneralMagnetItem[] = []
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const x = match[1]
    const item = createGeneralItem(xmlTag(x, 'nyaa:infoHash'), xmlTag(x, 'title'),
      'nyaa', '动漫', xmlTag(x, 'nyaa:size'), knownSeeders(xmlTag(x, 'nyaa:seeders')))
    if (item) result.push(item)
    if (result.length >= 40) break
  }
  return result
}
export function parseAcademicXml(xml: string): GeneralMagnetItem[] {
  const items: GeneralMagnetItem[] = []
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const x = match[1]
    const link = xmlTag(x, 'guid') || xmlTag(x, 'link')
    const hash = /\/details\/([a-f0-9]{40})(?:[/?#]|$)/i.exec(link)?.[1] || xmlTag(x, 'infohash')
    const item = createGeneralItem(hash, xmlTag(x, 'title'), 'academic', '学术/课程')
    if (item) items.push(item)
  }
  return items
}
async function fetchText(url: string, maxBytes: number): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'NetPanDownload/0.1 (general BT search)' },
    signal: AbortSignal.timeout(9000)
  })
  if (!response.ok) throw new Error(response.status === 429 ? '达到搜索源请求次数限制（429）' : 'HTTP ' + response.status)
  if (Number(response.headers?.get('content-length') || 0) > maxBytes) throw new Error('索引过大')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('索引超过容量限制')
  return text
}
async function searchBitSearch(query: string, category: GeneralCategory): Promise<GeneralMagnetItem[]> {
  const url = new URL('https://bitsearch.eu/api/v1/search')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '40')
  url.searchParams.set('sort', 'seeders')
  const ids: Partial<Record<GeneralCategory, string>> = { movie: '2', tv: '3', book: '9', anime: '4' }
  if (ids[category]) url.searchParams.set('category', ids[category])
  return parseBitSearchJson(JSON.parse(await fetchText(url.toString(), 2 * 1024 * 1024)))
}
async function searchNyaa(query: string): Promise<GeneralMagnetItem[]> {
  const url = new URL('https://nyaa.si/')
  url.searchParams.set('page', 'rss')
  url.searchParams.set('q', query)
  return parseNyaaRss(await fetchText(url.toString(), 2 * 1024 * 1024))
}
let academicCache: { expires: number; items: GeneralMagnetItem[] } | null = null
async function searchAcademic(query: string): Promise<GeneralMagnetItem[]> {
  if (!academicCache || academicCache.expires < Date.now()) {
    const xml = await fetchText('https://academictorrents.com/database.xml', 12 * 1024 * 1024)
    if (!/<rss\b|<rdf:RDF\b/i.test(xml)) throw new Error('学术索引格式错误')
    academicCache = { expires: Date.now() + 6 * 60 * 60 * 1000, items: parseAcademicXml(xml) }
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return academicCache.items.filter((item) => terms.every((term) => item.title.toLowerCase().includes(term))).slice(0, 30)
}
function supports(id: GeneralSourceId, category: GeneralCategory): boolean {
  if (id === 'nyaa') return category === 'all' || category === 'anime'
  if (id === 'academic') return category === 'all' || category === 'book' || category === 'learning'
  return true
}
export async function searchGeneralMagnets(rawQuery: unknown, rawCategory?: unknown, rawSource?: unknown): Promise<GeneralSearchResult> {
  const query = normalizeMagnetKeyword(rawQuery)
  const category = normalizeGeneralCategory(rawCategory)
  const requestedSource = normalizeGeneralSource(rawSource)
  const key = [query.toLowerCase(), category, requestedSource].join('|')
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) {
    for (const item of hit.result.items) registerAllowedDownloadUrl(item.magnet)
    return hit.result
  }
  const sources = (requestedSource === 'all' ? SOURCE_IDS : [requestedSource]).filter((id) => supports(id, category))
  if (!sources.length) throw new AppError('unsupported_source_category', '选择的搜索源不支持此分类')
  const promises = sources.map(async (id) => {
    if (id === 'bitsearch') return searchBitSearch(query, category)
    if (id === 'nyaa') return searchNyaa(query)
    return searchAcademic(query)
  })
  const settled = await Promise.allSettled(promises)
  const statuses: SourceStatus[] = []
  const found: GeneralMagnetItem[] = []
  settled.forEach((outcome, i) => {
    const id = sources[i]
    if (outcome.status === 'fulfilled') {
      statuses.push({ id, name: SOURCE_NAMES[id], ok: true, count: outcome.value.length })
      found.push(...outcome.value)
    } else {
      statuses.push({ id, name: SOURCE_NAMES[id], ok: false, count: 0,
        error: (outcome.reason instanceof Error ? outcome.reason.message : '未知错误').slice(0, 120) })
    }
  })
  if (statuses.every((status) => !status.ok)) {
    throw new AppError('sources_unavailable',
      '全部搜索源不可用：' + statuses.map((status) => status.name + '（' + status.error + '）').join('；'), 502)
  }
  const seen = new Set<string>()
  const items = found.filter((item) => {
    if (seen.has(item.hash)) return false
    seen.add(item.hash)
    return true
  }).sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1)).slice(0, 60)
  for (const item of items) registerAllowedDownloadUrl(item.magnet)
  const result: GeneralSearchResult = { query, category,
    source: requestedSource === 'all' ? '综合搜索' : SOURCE_NAMES[requestedSource], items, sources: statuses }
  cache.set(key, { result, expires: Date.now() + CACHE_MS })
  if (cache.size > 200) cache.delete(cache.keys().next().value as string)
  return result
}
