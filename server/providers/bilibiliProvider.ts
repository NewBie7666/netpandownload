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
  info: YtDlpInfo
  episodes: BiliEpisode[]
  files: QuarkFile[]
  createdAt: number
}

const execFileAsync = promisify(execFile)
const cacheTtlMs = 5 * 60 * 1000
const infoCache = new Map<string, CacheEntry>()
const bilibiliUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

function normalizeInput(input: string) {
  return String(input || '').trim().replace(/^['"]|['"]$/g, '')
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

  throw new AppError('bilibili_dash_unsupported', '该资源需要音视频合并，当前版本暂不支持 ffmpeg 合并')
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

async function resolveRealShare(inputUrl: string): Promise<ShareResult> {
  const normalizedUrl = normalizeInput(inputUrl)
  const info = await runYtDlpJson(['-J', '--yes-playlist', '--no-warnings', normalizedUrl])
  const episodes = normalizeBiliEpisodes(info)
  if (!episodes.length) {
    throw new AppError('bilibili_ytdlp_failed', 'Bilibili 未返回可识别的分集信息')
  }
  const files = episodes.map(episodeToFile)
  const shareId = normalizedUrl
  infoCache.set(shareId, {
    info,
    episodes,
    files,
    createdAt: Date.now()
  })
  return {
    shareId,
    stoken: 'bilibili-ytdlp',
    path: [],
    files
  }
}

async function resolveDownloadInfo(episode: BiliEpisode) {
  return runYtDlpJson(['--dump-single-json', '--no-download', '--no-warnings', episode.url])
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
      return providerOk('bilibili', await resolveRealShare(input.shareUrl), 'real')
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'resolve')
      return buildFallback('bilibili', normalized.code, normalized.message, normalized.code)
    }
  },
  async list(input) {
    const cached = getCacheEntry(input.shareId)
    if (cached) {
      return providerOk('bilibili', { files: cached.files }, 'cache')
    }
    return buildFallback(
      'bilibili',
      'missing_cache',
      'Bilibili 当前没有真实解析缓存，降级列表不可进入执行链路',
      'dependency_missing'
    )
  },
  async getDownload(input) {
    const cached = getCacheEntry(input.shareId)
    if (!cached) {
      return providerError(
        'bilibili',
        'dependency_missing',
        'Bilibili 当前没有真实解析缓存，不能生成可执行下载链接，请先完成真实解析',
        true,
        'fallback',
        'missing_cache'
      )
    }

    const index = cached.files.findIndex((file) => file.fid === input.file?.fid)
    const episode = cached.episodes[index]
    if (!episode?.url) {
      return providerError(
        'bilibili',
        'parse_failed',
        '未找到该分集对应的 Bilibili 地址，请重新解析资源',
        true,
        'fallback',
        'missing_episode'
      )
    }

    try {
      const info = await resolveDownloadInfo(episode)
      return providerOk(
        'bilibili',
        buildDownloadResult(input.file || cached.files[index], info),
        'real'
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
