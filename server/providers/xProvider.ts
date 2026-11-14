import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { QuarkFile, ShareResult } from '../../shared/types.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import { AppError } from '../http.js'
import { providerError, providerOk } from './providerResponse.js'
import type { Provider, ProviderErrorCode } from './types.js'

const execFileAsync = promisify(execFile)
const cache = new Map<string, { url: string; files: XMediaFile[]; updatedAt: number }>()
const cacheFreshMs = 60 * 1000
const cacheMaxEntries = 50
const directUrlTtlMs = 10 * 60 * 1000

interface XFormat {
  url?: string
  ext?: string
  protocol?: string
  vcodec?: string
  acodec?: string
  height?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export interface XVideoInfo {
  id?: string
  title?: string
  description?: string
  filesize?: number
  entries?: Array<XVideoInfo | null>
  formats?: XFormat[]
}

export interface XMediaFile {
  file: QuarkFile
  url: string
}

export function normalizeXPostUrl(input: string): { url: string; id: string } | null {
  const trimmed = String(input || '').trim().replace(/^['"]|['"]$/g, '')
  const withScheme = /^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)\//i.test(trimmed)
    ? 'https://' + trimmed
    : trimmed
  try {
    const url = new URL(withScheme)
    const host = url.hostname.toLowerCase().replace(/^(www|mobile)\./, '')
    if (!['x.com', 'twitter.com'].includes(host)) return null
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
    const match = url.pathname.match(/^\/(?:(?:[a-zA-Z0-9_]{1,15}|i)\/status|i\/web\/status)\/(\d+)(?:\/(?:video|photo)\/\d+)?\/?$/i)
    if (!match) return null
    url.protocol = 'https:'
    url.search = ''
    url.hash = ''
    return { url: url.toString(), id: match[1] }
  } catch {
    return null
  }
}

function isAllowedXVideoUrl(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'video.twimg.com' &&
      url.pathname.toLowerCase().endsWith('.mp4') &&
      !url.username && !url.password && !url.port
  } catch {
    return false
  }
}

function pickMp4(info: XVideoInfo): XFormat | undefined {
  return (info.formats || [])
    .filter((format) =>
      format.ext === 'mp4' &&
      (format.protocol === 'https' || format.protocol === 'http' || !format.protocol) &&
      format.vcodec !== 'none' &&
      typeof format.url === 'string' &&
      isAllowedXVideoUrl(format.url))
    .sort((a, b) => {
      const aAudio = a.acodec && a.acodec !== 'none' ? 1 : 0
      const bAudio = b.acodec && b.acodec !== 'none' ? 1 : 0
      return bAudio - aAudio || Number(b.height || 0) - Number(a.height || 0) || Number(b.tbr || 0) - Number(a.tbr || 0)
    })[0]
}

function flattenVideos(info: XVideoInfo): XVideoInfo[] {
  if (Array.isArray(info.entries)) {
    return info.entries.flatMap((entry) => entry ? flattenVideos(entry) : [])
  }
  return [info]
}

function safeTitle(info: XVideoInfo) {
  return String(info.title || info.description || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, 72)
}

export function selectXMediaFiles(info: XVideoInfo, postId: string): XMediaFile[] {
  const result: XMediaFile[] = []
  for (const entry of flattenVideos(info)) {
    const format = pickMp4(entry)
    if (!format?.url) continue
    const index = result.length
    const title = safeTitle(entry)
    const name = 'X-' + postId + '-' + (index + 1) + (title ? '-' + title : '') + '.mp4'
    result.push({
      file: {
        fid: 'x:' + postId + ':' + index,
        name,
        size: Math.max(0, Number(format.filesize || format.filesize_approx || entry.filesize || 0)),
        isDir: false,
        createdAt: ''
      },
      url: format.url
    })
  }
  return result
}

async function findYtDlp() {
  const configured = String(process.env.YTDLP_PATH || '').trim()
  const desktopRoot = String(process.env.QUARK_DESKTOP_ROOT || '').trim()
  const resourcesPath = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '').trim()
  const candidates = [
    configured,
    path.resolve(process.cwd(), 'resources', 'yt-dlp', 'win', 'yt-dlp.exe'),
    desktopRoot ? path.resolve(desktopRoot, 'resources', 'yt-dlp', 'win', 'yt-dlp.exe') : '',
    resourcesPath ? path.resolve(resourcesPath, 'yt-dlp', 'win', 'yt-dlp.exe') : '',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp'
  ].filter(Boolean)
  for (const executable of new Set(candidates)) {
    try {
      await access(executable, fsConstants.X_OK)
      return executable
    } catch {
      // Try the next candidate.
    }
  }
  throw new AppError('ytdlp_unavailable', '未找到 yt-dlp，请先运行 scripts/prepare-ytdlp.ps1 或设置 YTDLP_PATH')
}

async function extractXVideoInfo(url: string): Promise<XVideoInfo> {
  const executable = await findYtDlp()
  const { stdout } = await execFileAsync(
    executable,
    [
      '--dump-single-json',
      '--yes-playlist',
      '--skip-download',
      '--ignore-config',
      '--no-warnings',
      '--socket-timeout', '15',
      url
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 45000 }
  )
  if (!stdout.trim()) throw new AppError('x_parse_failed', 'X 未返回视频信息')
  try {
    return JSON.parse(stdout) as XVideoInfo
  } catch {
    throw new AppError('x_parse_failed', 'yt-dlp 返回的视频信息不是有效 JSON')
  }
}

function toXProviderError(error: unknown): { code: ProviderErrorCode; message: string } {
  if (error instanceof AppError) {
    return {
      code: error.error === 'ytdlp_unavailable' ? 'dependency_missing' : 'media_resolution_failed',
      message: error.message
    }
  }
  const detail = (error instanceof Error ? error.message : String(error)) +
    ' ' + String((error as { stderr?: string } | null)?.stderr || '')
  if (/log.?in|sign.?in|cookie|authentication|unauthorized|http error 401|http error 403/i.test(detail)) {
    return { code: 'auth_required', message: 'X 要求登录或限制访问，此版本仅支持无需登录即可解析的公开帖子' }
  }
  if (/http error 429|rate.limit|too many requests/i.test(detail)) {
    return { code: 'blocked_by_upstream', message: 'X 触发请求频率限制，请稍后重试' }
  }
  return { code: 'network_error', message: 'X 视频解析失败，请检查网络与 yt-dlp 版本，或稍后重试' }
}

async function loadPost(id: string, url?: string, force = false) {
  const key = 'x:' + id
  const existing = cache.get(key)
  if (!force && existing && Date.now() - existing.updatedAt < cacheFreshMs) return existing
  const sourceUrl = url || existing?.url || 'https://x.com/i/status/' + id
  const info = await extractXVideoInfo(sourceUrl)
  const files = selectXMediaFiles(info, id)
  if (!files.length) {
    throw new AppError('x_media_not_supported', '未找到可直接下载的 MP4；纯图片、HLS-only 视频或无权限帖子暂不支持')
  }
  const entry = { url: sourceUrl, files, updatedAt: Date.now() }
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > cacheMaxEntries) cache.delete(cache.keys().next().value!)
  return entry
}

async function fromShareId(shareId: string) {
  const match = /^x:(\d+)$/.exec(shareId)
  if (!match) throw new AppError('x_invalid_post', 'X 帖子 ID 无效，请重新解析链接')
  return loadPost(match[1])
}

export const xProvider: Provider = {
  id: 'x',
  name: 'X / Twitter',
  capabilities: { list: true, download: true, login: false, streaming: false },
  match(input) {
    return Boolean(normalizeXPostUrl(input))
  },
  async resolveShare(input) {
    const post = normalizeXPostUrl(input.shareUrl)
    if (!post) return providerError('x', 'parse_failed', '请输入有效的 X/Twitter 帖子链接', false)
    try {
      const resolved = await loadPost(post.id, post.url)
      const share: ShareResult = {
        shareId: 'x:' + post.id,
        stoken: 'x-public',
        path: [],
        files: resolved.files.map((item) => item.file)
      }
      return providerOk('x', share, 'real')
    } catch (error) {
      const failure = toXProviderError(error)
      return providerError('x', failure.code, failure.message, true)
    }
  },
  async list(input) {
    try {
      const post = await fromShareId(input.shareId)
      return providerOk('x', { files: post.files.map((item) => item.file) }, 'cache')
    } catch (error) {
      const failure = toXProviderError(error)
      return providerError('x', failure.code, failure.message, true)
    }
  },
  async getDownload(input) {
    try {
      const post = await fromShareId(input.shareId)
      const requestedId = String(input.file?.fid || '')
      const item = post.files.find((candidate) => candidate.file.fid === requestedId)
      if (!item) return providerError('x', 'download_url_missing', '视频信息已变化，请重新解析 X 链接', true)
      const result = {
        fid: item.file.fid,
        name: item.file.name,
        downloadUrl: item.url,
        source: 'direct' as const,
        expiresAt: new Date(Date.now() + directUrlTtlMs).toISOString(),
        cached: false
      }
      registerAllowedDownloadResult(result)
      return providerOk('x', result, 'real')
    } catch (error) {
      const failure = toXProviderError(error)
      return providerError('x', failure.code, failure.message, true)
    }
  }
}
