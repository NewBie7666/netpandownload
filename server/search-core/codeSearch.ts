import { AppError } from '../http.js'

export interface MagnetCandidate {
  hash: string
  title: string
  size: string
  magnet: string
  hasSubtitle: boolean
  isHD: boolean
}

export interface MagnetSearchResult {
  code: string
  source: string
  items: MagnetCandidate[]
}

const BASE = 'https://www.javbus.com'
const CACHE_MS = 10 * 60 * 1000
const cache = new Map<string, { expires: number; items: MagnetCandidate[] }>()
const timeoutMs = 12000

export type SearchTransport = (url: string, options: { headers?: Record<string, string>; maxBytes: number; timeoutMs: number }) => Promise<{ status: number; html: string }>

export function normalizeVideoCode(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('invalid_code', '请输入有效的番号')
  const normalized = value.trim().toUpperCase().replace(/[\s_]+/g, '-')
  if (!/^[A-Z]{2,12}-?\d{2,8}$/.test(normalized)) {
    throw new AppError('invalid_code', '番号格式不正确，例：ABP-123')
  }
  return normalized.replace(/^([A-Z]{2,12})(\d{2,8})$/, '$1-$2')
}

function unescapeHTML(input: string): string {
  return input.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCharCode(Number(decimal)))
}

function plainText(input: string): string {
  return unescapeHTML(input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

export function parseMagnetRows(html: string): MagnetCandidate[] {
  const items: MagnetCandidate[] = []
  const seen = new Set<string>()
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const match = row.match(/<a\b[^>]*href=["'](magnet:\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
    if (!match) continue
    const magnet = unescapeHTML(match[1])
    let url: URL
    try { url = new URL(magnet) } catch { continue }
    if (url.protocol !== 'magnet:') continue
    const hash = (url.searchParams.get('xt') || '').match(/^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i)?.[1].toLowerCase()
    if (!hash || seen.has(hash)) continue
    const title = plainText(match[2]).slice(0, 240) || hash
    const columns = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || []
    const size = columns[1] ? plainText(columns[1]).slice(0, 32) : ''
    seen.add(hash)
    items.push({
      hash, title, size, magnet,
      isHD: /高清|\bHD\b|1080p|2160p/i.test(row),
      hasSubtitle: /字幕|中字|subtitle/i.test(row)
    })
  }
  return items
}

export async function readPage(path: string, referer?: string, transport?: SearchTransport): Promise<{ status: number; html: string }> {
  if (transport) return transport(BASE + path, { maxBytes: 2 * 1024 * 1024, timeoutMs, headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cookie': 'existmag=mag; age=over18', ...(referer ? { Referer: referer } : {})
  } })
  const response = await fetch(BASE + path, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cookie': 'existmag=mag; age=over18',
      ...(referer ? { Referer: referer } : {})
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  })
  if (response.status !== 404 && !response.ok) {
    throw new AppError('source_error', '搜索源暂时不可用（HTTP ' + response.status + '）', 502)
  }
  return { status: response.status, html: response.status === 404 ? '' : await response.text() }
}

export async function searchByCode(rawCode: unknown, transport?: SearchTransport): Promise<MagnetSearchResult> {
  const code = normalizeVideoCode(rawCode)
  const existing = cache.get(code)
  if (existing && existing.expires > Date.now()) {
    return { code, source: 'JavBus', items: existing.items }
  }

  try {
    const detail = await readPage('/' + encodeURIComponent(code), undefined, transport)
    // Movie detail pages expose the gid and uc values needed for the magnet AJAX endpoint.
    const gid = /\bvar\s+gid\s*=\s*['"]?(\d+)/i.exec(detail.html)?.[1]
    const uc = /\bvar\s+uc\s*=\s*['"]?(\d+)/i.exec(detail.html)?.[1]
    if (!gid || !uc) {
      if (detail.status === 404) return { code, source: 'JavBus', items: [] }
      throw new AppError('source_blocked', '搜索源未返回有效影片数据，可能需要验证或当前网络无法访问', 502)
    }

    const query = new URLSearchParams({ lang: 'zh', gid, uc }).toString()
    const result = await readPage('/ajax/uncledatoolsbyajax.php?' + query, BASE + '/' + code, transport)
    const items = parseMagnetRows(result.html)
    if (cache.size >= 150) cache.delete(cache.keys().next().value as string)
    cache.set(code, { expires: Date.now() + CACHE_MS, items })
    return { code, source: 'JavBus', items }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('source_unreachable', '无法访问磁力搜索源：请检查当前网络连接', 502)
  }
}
