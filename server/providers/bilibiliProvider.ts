import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { DownloadResult, QuarkFile, ShareResult } from '../../shared/types.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import { AppError } from '../http.js'
import {
  buildFallback,
  normalizeProviderError,
  providerError,
  providerOk
} from './providerResponse.js'
import type { Provider } from './types.js'

interface YtDlpFormat {
  url?: string
  ext?: string
  filesize?: number
  filesize_approx?: number
  vcodec?: string
  acodec?: string
  protocol?: string
  format_id?: string
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
  files: QuarkFile[]
  createdAt: number
}

const execFileAsync = promisify(execFile)
const cacheTtlMs = 30 * 60 * 1000
const infoCache = new Map<string, CacheEntry>()
const bilibiliUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const mockFiles: QuarkFile[] = [
  {
    fid: 'bilibili:mock:episode-1',
    name: 'Bilibili Mock Part 1.mp4',
    size: 24 * 1024 * 1024,
    isDir: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString()
  },
  {
    fid: 'bilibili:mock:episode-2',
    name: 'Bilibili Mock Part 2.mp4',
    size: 32 * 1024 * 1024,
    isDir: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString()
  }
]

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
    typeof error === 'object' && error !== null && 'stderr' in error ? String((error as { stderr?: unknown }).stderr || '') : '',
    typeof error === 'object' && error !== null && 'stdout' in error ? String((error as { stdout?: unknown }).stdout || '') : ''
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
  throw new AppError('bilibili_ytdlp_failed', 'yt-dlp 解析 Bilibili 资源失败，已回退到 Mock 数据')
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

function toFile(info: YtDlpInfo, index: number): QuarkFile {
  const title = info.title || `Bilibili Part ${index + 1}`
  const size = info.filesize || info.filesize_approx || 0
  return {
    fid: `bilibili:real:${info.id || index}`,
    name: `${title}.${info.ext || 'mp4'}`,
    size,
    isDir: false,
    createdAt: new Date().toISOString()
  }
}

function normalizeFiles(info: YtDlpInfo) {
  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : []
  if (entries.length) {
    return entries.map(toFile)
  }
  return [toFile(info, 0)]
}

function getCacheEntry(shareId: string) {
  const entry = infoCache.get(shareId)
  if (!entry || Date.now() - entry.createdAt > cacheTtlMs) {
    return undefined
  }
  return entry
}

function buildMockShare(inputUrl: string): ShareResult {
  return {
    shareId: normalizeInput(inputUrl) || 'bilibili-mock-share',
    stoken: 'bilibili-mock-token',
    path: [],
    files: mockFiles
  }
}

function buildMockDownloadResult(file: QuarkFile): DownloadResult {
  const result: DownloadResult = {
    fid: file.fid,
    name: file.name,
    downloadUrl: `https://mock.local/bilibili/${encodeURIComponent(file.fid)}`,
    source: 'direct',
    expiresAt: new Date(Date.now() + cacheTtlMs).toISOString(),
    cached: false
  }
  registerAllowedDownloadResult(result)
  return result
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

async function resolveRealShare(inputUrl: string) {
  const normalizedUrl = normalizeInput(inputUrl)
  const info = await runYtDlpJson(['--dump-single-json', '--no-download', normalizedUrl])
  const files = normalizeFiles(info)
  const shareId = normalizedUrl
  infoCache.set(shareId, {
    info,
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

async function resolveDownloadInfo(cached: CacheEntry, index: number) {
  const entries = Array.isArray(cached.info.entries) ? cached.info.entries : []
  const selected = entries[index] || cached.info
  if (selected.url || selected.formats?.length || selected.requested_downloads?.length) {
    return selected
  }

  const targetUrl = selected.webpage_url || cached.info.webpage_url
  if (!targetUrl) {
    return selected
  }

  return runYtDlpJson(['--dump-single-json', '--no-download', '--no-playlist', targetUrl])
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
      return buildFallback('bilibili', buildMockShare(input.shareUrl), normalized.code)
    }
  },
  async list(input) {
    const cached = getCacheEntry(input.shareId)
    if (cached) {
      return providerOk('bilibili', { files: cached.files }, 'cache')
    }
    return buildFallback('bilibili', { files: mockFiles }, 'missing_cache')
  },
  async getDownload(input) {
    const cached = getCacheEntry(input.shareId)
    if (!cached) {
      return buildFallback(
        'bilibili',
        buildMockDownloadResult(input.file || mockFiles[0]),
        'missing_cache'
      )
    }

    const index = cached.files.findIndex((file) => file.fid === input.file?.fid)
    try {
      const info = await resolveDownloadInfo(cached, index)
      return providerOk(
        'bilibili',
        buildDownloadResult(input.file || cached.files[index] || cached.files[0], info),
        'real'
      )
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'download')
      if (normalized.code === 'dash_unsupported') {
        return providerError('bilibili', normalized.code, normalized.message, normalized.recoverable)
      }
      return buildFallback(
        'bilibili',
        buildMockDownloadResult(input.file || cached.files[0]),
        normalized.code
      )
    }
  }
}
