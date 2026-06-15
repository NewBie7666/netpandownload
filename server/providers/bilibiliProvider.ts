import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DownloadResult, QuarkFile, ShareResult } from '../../shared/types.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import { AppError } from '../http.js'
import {
  buildFallback,
  normalizeProviderError,
  providerError,
  providerOk
} from './providerResponse.js'
import { normalizeBiliEpisodes, type BiliEpisode } from './bilibili/bilibiliNormalizer.js'
import type { Provider } from './types.js'

interface YtDlpFormat {
  url?: string
  ext?: string
  filesize?: number
  filesize_approx?: number
  vcodec?: string
  acodec?: string
  protocol?: string
}

interface YtDlpInfo {
  id?: string
  title?: string
  duration?: number
  webpage_url?: string
  entries?: YtDlpInfo[]
  formats?: YtDlpFormat[]
  requested_downloads?: YtDlpFormat[]
  url?: string
  ext?: string
  filesize?: number
  filesize_approx?: number
}

interface CacheEntry {
  raw: YtDlpInfo
  episodes: BiliEpisode[]
  files: QuarkFile[]
  createdAt: number
}

const execFileAsync = promisify(execFile)
const cacheTtlMs = 15 * 60 * 1000
const infoCache = new Map<string, CacheEntry>()
const bilibiliUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

function normalizeInput(input: string) {
  return String(input || '').trim().replace(/^['"]|['"]$/g, '')
}

function canonicalizeBiliUrl(input: string) {
  const value = normalizeInput(input)
  try {
    const url = new URL(value)
    const bvMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)
    if (/^(www\.)?bilibili\.com$/i.test(url.hostname) && bvMatch) {
      return `https://www.bilibili.com/video/${bvMatch[1]}`
    }

    if (/^(www\.)?bilibili\.com$/i.test(url.hostname) && /^\/bangumi\/play\//i.test(url.pathname)) {
      return `https://www.bilibili.com${url.pathname.replace(/\/+$/, '')}`
    }

    // b23.tv is a short link. We intentionally do not expand it here because
    // canonicalization must not introduce extra network requests.
    if (/^b23\.tv$/i.test(url.hostname)) {
      return `https://b23.tv${url.pathname.replace(/\/+$/, '')}`
    }
  } catch {
    // Keep the normalized input so unsupported URL errors stay readable.
  }
  return value
}

function toCacheKey(input: string) {
  return `bili:${canonicalizeBiliUrl(input)}`
}

function isBilibiliUrl(input: string) {
  const value = normalizeInput(input)
  try {
    const url = new URL(value)
    if (/^(www\.)?bilibili\.com$/i.test(url.hostname)) {
      return /^\/video\/BV[0-9A-Za-z]+/i.test(url.pathname) || /^\/bangumi\/play\//i.test(url.pathname)
    }
    return /^b23\.tv$/i.test(url.hostname) && url.pathname.length > 1
  } catch {
    return false
  }
}

function getYtDlpCandidates() {
  const configured = String(process.env.YTDLP_PATH || '').trim()
  const desktopRoot = String(process.env.QUARK_DESKTOP_ROOT || '').trim()
  const resourcesPath = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '').trim()
  const candidates = [
    configured,
    path.resolve(process.cwd(), 'resources', 'yt-dlp', 'win', 'yt-dlp.exe'),
    desktopRoot ? path.resolve(desktopRoot, 'resources', 'yt-dlp', 'win', 'yt-dlp.exe') : '',
    resourcesPath ? path.resolve(resourcesPath, 'yt-dlp', 'win', 'yt-dlp.exe') : ''
  ].filter(Boolean)
  return Array.from(new Set(candidates))
}

async function resolveYtDlpExecutable() {
  for (const candidate of getYtDlpCandidates()) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Try next candidate.
    }
  }
  return ''
}

function readExecErrorText(error: unknown) {
  const parts = [
    error instanceof Error ? error.message : '',
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr || '')
      : '',
    typeof error === 'object' && error !== null && 'stdout' in error
      ? String((error as { stdout?: unknown }).stdout || '')
      : ''
  ]
  return parts.filter(Boolean).join('\n')
}

function throwYtDlpError(error: unknown): never {
  if (error instanceof AppError) {
    throw error
  }

  const text = readExecErrorText(error)
  const lowered = text.toLowerCase()
  if (lowered.includes('http error 412') || lowered.includes('precondition failed')) {
    throw new AppError(
      'bilibili_blocked_by_upstream',
      'B站返回风控限制，当前版本未接入 B站登录态，无法保证解析成功'
    )
  }
  if (
    lowered.includes('login') ||
    lowered.includes('private') ||
    lowered.includes('会员') ||
    lowered.includes('付费') ||
    lowered.includes('drm') ||
    lowered.includes('region')
  ) {
    throw new AppError(
      'bilibili_access_restricted',
      '该资源可能需要登录、会员权限、地区权限或受到 DRM 限制，当前版本不支持绕过'
    )
  }
  if (
    lowered.includes('timed out') ||
    lowered.includes('timeout') ||
    lowered.includes('econnreset') ||
    lowered.includes('enotfound') ||
    lowered.includes('network')
  ) {
    throw new AppError('bilibili_network_error', 'Bilibili 解析请求失败，请稍后重试')
  }
  throw new AppError('bilibili_ytdlp_failed', 'yt-dlp 解析 Bilibili 资源失败')
}

async function runYtDlpJson(args: string[]) {
  const executable = await resolveYtDlpExecutable()
  if (!executable) {
    throw new AppError('ytdlp_unavailable', '请先运行 scripts/prepare-ytdlp.ps1 准备 yt-dlp.exe')
  }

  try {
    const finalArgs = ['--user-agent', bilibiliUserAgent, '--referer', 'https://www.bilibili.com', ...args]
    const { stdout } = await execFileAsync(executable, finalArgs, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      timeout: 60000
    })
    return JSON.parse(stdout) as YtDlpInfo
  } catch (error) {
    throwYtDlpError(error)
  }
}

function episodeToFile(episode: BiliEpisode): QuarkFile {
  // QuarkFile is only a UI compatibility DTO here; BiliEpisode remains the semantic media model.
  return {
    fid: `bilibili:episode:${episode.id}`,
    name: episode.title,
    size: 0,
    isDir: false,
    createdAt: new Date().toISOString()
  }
}

function getCacheEntry(shareId: string) {
  const entry = infoCache.get(shareId)
  if (!entry || Date.now() - entry.createdAt > cacheTtlMs) {
    infoCache.delete(shareId)
    return undefined
  }
  return entry
}

function assertEpisodeConsistency(entry: CacheEntry) {
  if (entry.episodes.length !== entry.files.length) {
    throw new AppError('episode_inconsistent_state', 'Bilibili 分集缓存状态不一致，请重新解析资源')
  }
}

function selectSingleFileFormat(info: YtDlpInfo) {
  const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads : []
  if (requested.length > 1) {
    throw new AppError('bilibili_dash_unsupported', '该资源需要音视频合并，当前版本暂不支持 ffmpeg 合并')
  }
  if (requested[0]?.url) {
    return requested[0]
  }

  const formats = Array.isArray(info.formats) ? info.formats : []
  const merged = formats.find((format) => {
    const hasVideo = format.vcodec && format.vcodec !== 'none'
    const hasAudio = format.acodec && format.acodec !== 'none'
    return Boolean(format.url && hasVideo && hasAudio && format.protocol !== 'm3u8_native')
  })
  if (merged?.url) {
    return merged
  }

  if (info.url) {
    return info
  }

  throw new AppError('download_url_missing', 'Bilibili 未返回可直接下载的链接，请重新解析或等待后续 ffmpeg 支持')
}

function getCachedDownloadInfo(episode: BiliEpisode): YtDlpInfo {
  if (episode.downloadInfo && typeof episode.downloadInfo === 'object') {
    return episode.downloadInfo as YtDlpInfo
  }
  throw new AppError('download_url_missing', 'Bilibili 分集缓存中没有可直接下载的链接，请重新解析或等待后续 ffmpeg 支持')
}

function buildDownloadResult(file: QuarkFile, info: YtDlpInfo): DownloadResult {
  const format = selectSingleFileFormat(info)
  const result: DownloadResult = {
    fid: file.fid,
    name: file.name,
    downloadUrl: format.url,
    source: 'direct',
    expiresAt: new Date(Date.now() + cacheTtlMs).toISOString(),
    cached: false
  }
  registerAllowedDownloadResult(result)
  return result
}

function debugProvider(message: string, details: Record<string, unknown>) {
  if (process.env.PROVIDER_DEBUG === 'true') {
    console.info(`[provider:bilibili] ${message}`, details)
  }
}

async function resolveRealShare(inputUrl: string): Promise<ShareResult> {
  const canonicalUrl = canonicalizeBiliUrl(inputUrl)
  const cacheKey = toCacheKey(inputUrl)
  const raw = await runYtDlpJson(['-J', '--yes-playlist', '--no-warnings', canonicalUrl])
  const episodes = normalizeBiliEpisodes(raw)
  if (!episodes.length) {
    throw new AppError('bilibili_ytdlp_failed', 'Bilibili 未返回可识别的分集信息')
  }
  const files = episodes.map(episodeToFile)
  const entry: CacheEntry = {
    raw,
    episodes,
    files,
    createdAt: Date.now()
  }
  assertEpisodeConsistency(entry)
  infoCache.set(cacheKey, entry)
  debugProvider('resolve', { episodeCount: episodes.length, source: 'yt-dlp', canonicalUrl })
  return {
    shareId: cacheKey,
    stoken: 'bilibili-ytdlp',
    path: [],
    files
  }
}

export const bilibiliProvider: Provider = {
  id: 'bilibili',
  name: 'Bilibili',
  capabilities: {
    list: true,
    download: true,
    login: false,
    streaming: false
  },
  match(input) {
    return isBilibiliUrl(input)
  },
  async resolveShare(input) {
    try {
      const result = await resolveRealShare(input.shareUrl)
      return providerOk('bilibili', result, 'real', undefined, {
        episodeCount: result.files.length,
        source: 'yt-dlp',
        canonicalUrl: canonicalizeBiliUrl(input.shareUrl)
      })
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'resolve')
      return buildFallback('bilibili', normalized.code, normalized.message, normalized.code)
    }
  },
  async list(input) {
    const cached = getCacheEntry(input.shareId)
    if (!cached) {
      return buildFallback(
        'bilibili',
        'episode_cache_miss',
        'Bilibili 分集缓存不存在或已过期，请重新解析资源',
        'episode_cache_miss'
      )
    }

    try {
      assertEpisodeConsistency(cached)
      debugProvider('list', { episodeCount: cached.episodes.length, source: 'cache' })
      return providerOk('bilibili', { files: cached.files }, 'cache', undefined, {
        episodeCount: cached.episodes.length,
        source: 'cache'
      })
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'list')
      return providerError('bilibili', normalized.code, normalized.message, normalized.recoverable, 'cache')
    }
  },
  async getDownload(input) {
    const cached = getCacheEntry(input.shareId)
    if (!cached) {
      return providerError(
        'bilibili',
        'episode_cache_miss',
        'Bilibili 分集缓存不存在或已过期，请重新解析资源',
        true,
        'fallback',
        'episode_cache_miss'
      )
    }

    try {
      assertEpisodeConsistency(cached)
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'download')
      return providerError('bilibili', normalized.code, normalized.message, normalized.recoverable, 'cache')
    }

    const index = cached.files.findIndex((file) => file.fid === input.file?.fid)
    const episode = cached.episodes[index]
    if (!episode) {
      return providerError(
        'bilibili',
        'episode_cache_miss',
        '未找到该分集缓存，请重新解析资源',
        true,
        'fallback',
        'missing_episode'
      )
    }

    try {
      debugProvider('download', {
        episodeCount: cached.episodes.length,
        source: 'cache',
        resolvedEpisodeId: episode.id
      })
      return providerOk(
        'bilibili',
        buildDownloadResult(input.file || cached.files[index], getCachedDownloadInfo(episode)),
        'real',
        undefined,
        {
          episodeCount: cached.episodes.length,
          source: 'cache',
          resolvedEpisodeId: episode.id
        }
      )
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'download')
      return providerError(
        'bilibili',
        normalized.code,
        normalized.message,
        normalized.recoverable,
        'fallback',
        normalized.code
      )
    }
  }
}
