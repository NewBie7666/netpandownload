import { AppError } from '../../../http.js'
import { normalizeBiliUrl } from '../resolver/index.js'
import type { YtDlpInfo } from '../resolver/index.js'
import { throttleBilibiliRequest, toBilibiliFailSafeError, withBilibiliRetry } from '../stability/index.js'
import { createAccessContext } from './context.js'
import { buildBilibiliHeaders } from './headers.js'
import { BilibiliAccessError, classifyAccessError } from './retryPolicy.js'
import { runYtDlpJson } from './ytDlpRunner.js'

function toAppError(error: unknown): AppError {
  const classified = classifyAccessError(error)
  if (classified.reason === 'dependency_missing') {
    return new AppError('ytdlp_unavailable', '未找到 yt-dlp，无法解析 B站资源')
  }
  if (classified.reason === 'restricted') {
    return new AppError('bilibili_access_restricted', '该 B站资源需要更高登录态或访问权限')
  }
  if (classified.reason === '412_or_network_block') {
    return new AppError('bilibili_blocked_by_upstream', 'B站返回风控限制，请稍后重试或配置后端 BILIBILI_COOKIE')
  }
  if (classified.reason === 'network_error') {
    return new AppError('bilibili_network_error', 'B站解析请求失败，请稍后重试')
  }
  return new AppError('bilibili_access_failed', 'B站解析失败，请稍后重试')
}

export async function resolveBilibiliAccess(url: string): Promise<YtDlpInfo> {
  try {
    return await runYtDlpJson(url)
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

export async function fetchBilibiliInitialState(url: string): Promise<YtDlpInfo> {
  const context = createAccessContext(normalizeBiliUrl(url))
  return withBilibiliRetry(async () => {
    try {
      await throttleBilibiliRequest(context.episodeSessionId || context.url)
      const response = await fetch(context.url, {
        method: 'GET',
        redirect: 'follow',
        headers: buildBilibiliHeaders(context),
        signal: AbortSignal.timeout(8000)
      })
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
      return extractInitialState(html)
    } catch (error) {
      throw toAppError(error)
    }
  }).catch((error) => {
    throw toBilibiliFailSafeError(error, 'resolve')
  })
}

async function expandOnce(url: string) {
  const context = createAccessContext(url)
  await throttleBilibiliRequest(context.episodeSessionId || context.url)
  const response = await fetch(context.url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: buildBilibiliHeaders(context),
    signal: AbortSignal.timeout(5000)
  })
  if (response.status === 412) {
    throw new BilibiliAccessError('412_or_network_block', 'Bilibili short URL expansion was blocked', true, 412)
  }
  return normalizeBiliUrl(response.url || url)
}

export async function expandBilibiliShortUrl(url: string) {
  try {
    return await withBilibiliRetry(() => expandOnce(url))
  } catch {
    return normalizeBiliUrl(url)
  }
}

export { BilibiliAccessError, runYtDlpJson }
