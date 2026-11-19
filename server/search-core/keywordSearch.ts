import { AppError } from '../http.js'
import { normalizeVideoCode, readPage, type SearchTransport } from './codeSearch.js'

export interface MagnetMovie {
  code: string
  title: string
}

export interface MagnetKeywordResult {
  query: string
  source: string
  movies: MagnetMovie[]
}

const BASE = 'https://www.javbus.com'
const CACHE_MS = 10 * 60 * 1000
const LIMIT = 40
const cache = new Map<string, { expires: number; movies: MagnetMovie[] }>()

export function normalizeMagnetKeyword(raw: unknown): string {
  if (typeof raw !== 'string') throw new AppError('invalid_query', '请输入搜索关键词或部分番号')
  const query = raw.trim().replace(/\s+/g, ' ')
  if (query.length < 2 || query.length > 80 || /[<>\u0000-\u001f\u007f]/.test(query) || /^https?:\/\//i.test(query)) {
    throw new AppError('invalid_query', '关键词长度需为 2～80 个字符，不能输入链接或控制字符')
  }
  return query
}

function textFromHTML(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, ' ').trim()
}

/** Extract first-page movie matches, not magnet links. Each selection uses the existing exact-code API. */
export function parseMovieCards(html: string): MagnetMovie[] {
  const movies: MagnetMovie[] = []
  const seen = new Set<string>()
  for (const anchor of html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []) {
    const open = anchor.match(/^<a\b[^>]*>/i)?.[0] || ''
    if (!/\bclass\s*=\s*(["'])[^"']*\bmovie-box\b[^"']*\1/i.test(open)) continue
    const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(open)?.[2]
    if (!href) continue

    let code: string
    try {
      const url = new URL(href.replace(/&amp;/gi, '&'), BASE)
      if (url.origin !== BASE) continue
      const parts = url.pathname.split('/').filter(Boolean)
      // Search, actor and pagination paths are not movie detail URLs.
      if (parts.length !== 1 && !(parts.length === 2 && /^(?:ja|cn|en)$/i.test(parts[0]))) continue
      const rawCode = decodeURIComponent(parts[parts.length - 1] || '')
      code = normalizeVideoCode(rawCode)
    } catch {
      continue
    }
    if (seen.has(code)) continue

    const info = /<div\b[^>]*class\s*=\s*(["'])[^"']*\bphoto-info\b[^"']*\1[^>]*>([\s\S]*?)<\/div>/i.exec(anchor)?.[2] || anchor
    const cleaned = info.replace(/<date\b[^>]*>[\s\S]*?<\/date>/gi, ' ')
    const title = textFromHTML(cleaned).slice(0, 240) || code
    seen.add(code)
    movies.push({ code, title })
    if (movies.length >= LIMIT) break
  }
  return movies
}

function relevance(movie: MagnetMovie, query: string): number {
  const terms = query.toLocaleLowerCase().split(' ').filter(Boolean)
  const code = movie.code.toLocaleLowerCase()
  const title = movie.title.toLocaleLowerCase()
  return terms.reduce((score, term) => {
    if (code === term) return score + 10
    if (code.startsWith(term)) return score + 6
    if (code.includes(term)) return score + 4
    if (title.includes(term)) return score + 2
    return score
  }, 0)
}

export async function searchByKeyword(raw: unknown, transport?: SearchTransport): Promise<MagnetKeywordResult> {
  const query = normalizeMagnetKeyword(raw)
  const key = query.toLocaleLowerCase()
  const existing = cache.get(key)
  if (existing && existing.expires > Date.now()) {
    return { query, source: 'JavBus', movies: existing.movies }
  }

  const encoded = encodeURIComponent(query)
  const pages = await Promise.allSettled([
    readPage('/search/' + encoded, undefined, transport),
    readPage('/uncensored/search/' + encoded, undefined, transport)
  ])
  const good = pages.filter((page): page is PromiseFulfilledResult<Awaited<ReturnType<typeof readPage>>> => page.status === 'fulfilled')
  if (!good.length) {
    const failure = pages[0]
    if (failure.status === 'rejected' && failure.reason instanceof AppError) throw failure.reason
    throw new AppError('source_unreachable', '无法访问磁力搜索源：请检查当前网络连接', 502)
  }
  if (good.every(({ value }) => /cf-chl-|just a moment|captcha|人机验证/i.test(value.html))) {
    throw new AppError('source_blocked', '搜索源要求验证，当前无法获取搜索结果', 502)
  }

  const movies: MagnetMovie[] = []
  const seen = new Set<string>()
  for (const page of good) {
    for (const movie of parseMovieCards(page.value.html)) {
      if (seen.has(movie.code)) continue
      seen.add(movie.code)
      movies.push(movie)
    }
  }
  movies.sort((a, b) => relevance(b, query) - relevance(a, query))
  const limited = movies.slice(0, LIMIT)
  cache.set(key, { expires: Date.now() + CACHE_MS, movies: limited })
  if (cache.size > 150) cache.delete(cache.keys().next().value as string)
  return { query, source: 'JavBus', movies: limited }
}
