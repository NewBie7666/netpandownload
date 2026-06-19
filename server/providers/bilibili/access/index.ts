import { AppError } from '../../../http.js'
import { createHash } from 'node:crypto'
import { cookieHealthProbe } from '../authContext/index.js'
import type { BilibiliTraceContext } from '../observability/index.js'
import { createTraceEvent, recordTraceEvent, traceStage } from '../observability/index.js'
import { normalizeBiliUrl } from '../resolver/index.js'
import type { YtDlpInfo } from '../resolver/index.js'
import { throttleBilibiliRequest, toBilibiliFailSafeError, withBilibiliRetry, withFailureLayer } from '../stability/index.js'
import { createAccessContext } from './context.js'
import { buildBilibiliHeaders } from './headers.js'
import { BilibiliAccessError, classifyAccessError } from './retryPolicy.js'
import { runYtDlpJson } from './ytDlpRunner.js'

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

function toAppError(error: unknown): AppError {
  const classified = classifyAccessError(error)
  if (classified.reason === 'dependency_missing') {
    return new AppError('ytdlp_unavailable', '未找到 yt-dlp，无法解析 B站资源')
  }
  if (classified.reason === 'restricted') {
    return new AppError('bilibili_access_restricted', '该 B站资源需要更高登录状态或访问权限')
  }
  if (classified.reason === '412_or_network_block') {
    return new AppError('bilibili_blocked_by_upstream', 'B站返回风控限制，请稍后重试或登录后再试')
  }
  if (classified.reason === 'network_error') {
    return new AppError('bilibili_network_error', 'B站解析请求失败，请稍后重试')
  }
  return new AppError('bilibili_access_failed', 'B站解析失败，请稍后重试')
}

export async function resolveBilibiliAccess(url: string, traceContext?: BilibiliTraceContext): Promise<YtDlpInfo> {
  try {
    await traceStage(traceContext, 'auth', () => cookieHealthProbe(), recordTraceEvent)
    return await traceStage(
      traceContext,
      'access',
      () => withFailureLayer('ytDlp', () => runYtDlpJson(url)),
      recordTraceEvent
    )
  } catch (error) {
    throw toAppError(error)
  }
}

function extractInitialState(html: string) {
  const marker = 'window.__INITIAL_STATE__='
  const start = html.indexOf(marker)
  if (start < 0) {
    throw new BilibiliAccessError('empty_response', 'Bilibili page initial state is missing', true)
  }

  const jsonStart = start + marker.length
  const endMarkers = [';(function()', ';window.__INITIAL_STATE__', '</script>']
  const ends = endMarkers
    .map((markerText) => html.indexOf(markerText, jsonStart))
    .filter((index) => index > jsonStart)
  const jsonEnd = ends.length ? Math.min(...ends) : -1
  if (jsonEnd < 0) {
    throw new BilibiliAccessError('parse_failed', 'Bilibili page initial state boundary is missing', true)
  }

  try {
    return JSON.parse(html.slice(jsonStart, jsonEnd)) as YtDlpInfo
  } catch {
    throw new BilibiliAccessError('parse_failed', 'Bilibili page initial state is invalid JSON', true)
  }
}

function decodeHtmlText(value: string) {
  return value
    .replace(/<em[^>]*>/gi, '')
    .replace(/<\/em>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function parseSpaceSearchUrl(url: string) {
  try {
    const parsed = new URL(url)
    const midMatch = parsed.pathname.match(/^\/(\d+)\/search\/?$/)
    if (!/^space\.bilibili\.com$/i.test(parsed.hostname) || !midMatch) return undefined
    return {
      mid: midMatch[1],
      keyword: parsed.searchParams.get('keyword') || ''
    }
  } catch {
    return undefined
  }
}

function extractWbiKey(urlValue: unknown) {
  const match = String(urlValue || '').match(/\/([^/?#]+)\.(?:png|jpg|webp)/i)
  return match?.[1] || ''
}

function getMixinKey(imgKey: string, subKey: string) {
  const raw = `${imgKey}${subKey}`
  return mixinKeyEncTab.map((index) => raw[index] || '').join('').slice(0, 32)
}

function encodeWbiValue(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function signWbiParams(params: Record<string, string>, mixinKey: string) {
  const withTime: Record<string, string> = {
    ...params,
    wts: Math.floor(Date.now() / 1000).toString()
  }
  const query = Object.keys(withTime)
    .sort()
    .map((key) => `${encodeWbiValue(key)}=${encodeWbiValue(withTime[key] || '')}`)
    .join('&')
  const wRid = createHash('md5').update(`${query}${mixinKey}`).digest('hex')
  return `${query}&w_rid=${wRid}`
}

function parseSearchHtmlCards(html: string, mid?: string) {
  const midItems: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const cardPattern = /<a href="\/\/www\.bilibili\.com\/video\/(BV[0-9A-Za-z]+)\/?"[^>]*>[\s\S]*?<h3[^>]*(?:title="([^"]*)")?[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<a class="bili-video-card__info--owner" href="\/\/space\.bilibili\.com\/(\d+)"/gi

  for (const match of html.matchAll(cardPattern)) {
    const bvid = match[1]
    if (!bvid || seen.has(bvid)) continue

    const title = decodeHtmlText(match[2] || match[3] || bvid)
    const cardStart = Math.max(0, match.index || 0)
    const cardEnd = html.indexOf('<div class="bili-video-card"', cardStart + 1)
    const card = html.slice(cardStart, cardEnd > cardStart ? cardEnd : cardStart + 3000)
    const durationText = card.match(/bili-video-card__stats__duration"[^>]*>([^<]+)</i)?.[1]
    const item = {
      bvid,
      title,
      durationText: durationText ? decodeHtmlText(durationText) : undefined
    }

    seen.add(bvid)
    if (mid && match[4] === mid) {
      midItems.push(item)
    }
  }

  return mid ? midItems : []
}

async function fetchJson(url: string, referer: string, traceContext?: BilibiliTraceContext) {
  const context = createAccessContext(url)
  const headers = {
    ...buildBilibiliHeaders(context),
    Referer: referer
  }
  const response = await traceStage(
    traceContext,
    'access',
    () => withFailureLayer('access', () => fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(8000)
    })),
    recordTraceEvent
  )
  if (response.status === 412) {
    throw new BilibiliAccessError('412_or_network_block', 'Bilibili space search request was blocked', true, 412)
  }
  if (!response.ok) {
    throw new BilibiliAccessError('network_error', `Bilibili space search request failed: ${response.status}`, true, response.status)
  }
  return response.json() as Promise<Record<string, unknown>>
}

function getNestedRecord(value: unknown, key: string) {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getSpaceSearchVlist(data: Record<string, unknown>) {
  const list = getNestedRecord(getNestedRecord(getNestedRecord(data, 'data'), 'list'), 'vlist')
  return Array.isArray(list) ? list.filter((item) => typeof item === 'object' && item !== null) : []
}

function getSpaceSearchTotal(data: Record<string, unknown>) {
  return asNumber(getNestedRecord(getNestedRecord(getNestedRecord(data, 'data'), 'page'), 'count'))
}

async function fetchSpaceSearchPage(
  parsed: { mid: string; keyword: string },
  mixinKey: string,
  referer: string,
  pageNumber: number,
  pageSize: number,
  traceContext?: BilibiliTraceContext
) {
  const query = signWbiParams({
    mid: parsed.mid,
    keyword: parsed.keyword,
    order: 'pubdate',
    pn: String(pageNumber),
    ps: String(pageSize)
  }, mixinKey)
  const apiUrl = `https://api.bilibili.com/x/space/wbi/arc/search?${query}`
  const data = await fetchJson(apiUrl, referer, traceContext)
  const code = Number(data.code)
  if (code !== 0) {
    throw new BilibiliAccessError(
      code === -352 ? '412_or_network_block' : 'network_error',
      `Bilibili space search API failed: ${data.message || code}`,
      true
    )
  }

  return {
    total: getSpaceSearchTotal(data),
    vlist: getSpaceSearchVlist(data)
  }
}

async function fetchSpaceSearchApi(url: string, traceContext?: BilibiliTraceContext): Promise<YtDlpInfo | undefined> {
  const parsed = parseSpaceSearchUrl(url)
  if (!parsed?.keyword) return undefined

  const referer = `https://space.bilibili.com/${parsed.mid}/search?keyword=${encodeURIComponent(parsed.keyword)}`
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav', referer, traceContext)
  const wbiImg = getNestedRecord(getNestedRecord(nav, 'data'), 'wbi_img')
  const imgKey = extractWbiKey(getNestedRecord(wbiImg, 'img_url'))
  const subKey = extractWbiKey(getNestedRecord(wbiImg, 'sub_url'))
  const mixinKey = getMixinKey(imgKey, subKey)
  if (!mixinKey) return undefined

  const pageSize = 30
  const maxPages = 10
  const collected: unknown[] = []
  let total: number | undefined

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const page = await fetchSpaceSearchPage(parsed, mixinKey, referer, pageNumber, pageSize, traceContext)
    total = page.total ?? total
    if (!page.vlist.length) break
    collected.push(...page.vlist)
    if (typeof total === 'number' && collected.length >= total) break
    if (page.vlist.length < pageSize) break
  }

  return collected.length ? { page: { vlist: collected } } as YtDlpInfo : undefined
}

async function fetchSpaceSearchFallback(url: string, traceContext?: BilibiliTraceContext): Promise<YtDlpInfo | undefined> {
  const parsed = parseSpaceSearchUrl(url)
  if (!parsed?.keyword) return undefined

  const searchUrl = `https://search.bilibili.com/all?keyword=${encodeURIComponent(parsed.keyword)}`
  const context = createAccessContext(searchUrl)
  await throttleBilibiliRequest(context.episodeSessionId || context.url)
  const response = await traceStage(
    traceContext,
    'access',
    () => withFailureLayer('access', () => fetch(searchUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: buildBilibiliHeaders(context),
      signal: AbortSignal.timeout(8000)
    })),
    recordTraceEvent
  )
  if (!response.ok) return undefined

  const html = await response.text()
  const vlist = parseSearchHtmlCards(html, parsed.mid)
  return vlist.length ? { page: { vlist } } as YtDlpInfo : undefined
}

export async function fetchBilibiliInitialState(url: string, traceContext?: BilibiliTraceContext): Promise<YtDlpInfo> {
  await traceStage(traceContext, 'auth', () => cookieHealthProbe(), recordTraceEvent)
  const context = createAccessContext(normalizeBiliUrl(url))
  return withBilibiliRetry(async () => {
    try {
      await throttleBilibiliRequest(context.episodeSessionId || context.url)
      const response = await traceStage(
        traceContext,
        'access',
        () => withFailureLayer('access', () => fetch(context.url, {
          method: 'GET',
          redirect: 'follow',
          headers: buildBilibiliHeaders(context),
          signal: AbortSignal.timeout(8000)
        })),
        recordTraceEvent
      )
      if (response.status === 412) {
        throw new BilibiliAccessError('412_or_network_block', 'Bilibili page request was blocked', true, 412)
      }
      if (!response.ok) {
        throw new BilibiliAccessError('network_error', `Bilibili page request failed: ${response.status}`, true, response.status)
      }

      const html = await response.text()
      if (!html.trim()) {
        throw new BilibiliAccessError('empty_response', 'Bilibili page returned empty response', true)
      }
      const spaceSearchApi = await fetchSpaceSearchApi(url, traceContext)
      if (spaceSearchApi) {
        return spaceSearchApi
      }
      const spaceSearchFallback = await fetchSpaceSearchFallback(url, traceContext)
      if (spaceSearchFallback) {
        return spaceSearchFallback
      }
      return extractInitialState(html)
    } catch (error) {
      throw toAppError(error)
    }
  }, undefined, {
    onStateChange: (state) => {
      if (state === 'retry_once') recordTraceEvent(traceContext, createTraceEvent('retry', 'start'))
      if (state === 'degrade_mode') recordTraceEvent(traceContext, createTraceEvent('retry', 'degraded'))
      if (state === 'give_up') recordTraceEvent(traceContext, createTraceEvent('retry', 'fail'))
    }
  }).catch((error) => {
    throw toBilibiliFailSafeError(error, 'resolve')
  })
}

async function expandOnce(url: string, traceContext?: BilibiliTraceContext) {
  const context = createAccessContext(url)
  await throttleBilibiliRequest(context.episodeSessionId || context.url)
  const response = await traceStage(
    traceContext,
    'access',
    () => withFailureLayer('access', () => fetch(context.url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: buildBilibiliHeaders(context),
      signal: AbortSignal.timeout(5000)
    })),
    recordTraceEvent
  )
  if (response.status === 412) {
    throw new BilibiliAccessError('412_or_network_block', 'Bilibili short URL expansion was blocked', true, 412)
  }
  return normalizeBiliUrl(response.url || url)
}

export async function expandBilibiliShortUrl(url: string, traceContext?: BilibiliTraceContext) {
  try {
    return await withBilibiliRetry(() => expandOnce(url, traceContext), undefined, {
      onStateChange: (state) => {
        if (state === 'retry_once') recordTraceEvent(traceContext, createTraceEvent('retry', 'start'))
        if (state === 'degrade_mode') recordTraceEvent(traceContext, createTraceEvent('retry', 'degraded'))
        if (state === 'give_up') recordTraceEvent(traceContext, createTraceEvent('retry', 'fail'))
      }
    })
  } catch {
    return normalizeBiliUrl(url)
  }
}

export { BilibiliAccessError, runYtDlpJson }
