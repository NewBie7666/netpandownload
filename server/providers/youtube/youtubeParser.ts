import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import type { QuarkFile } from '../../../shared/types.js'
import { AppError } from '../../http.js'

const run = promisify(execFile)

export interface YoutubeVideo {
  shareId: string
  url: string
  id: string
  file: QuarkFile
  mediaUrl: string
}

export function normalizeYoutubeUrl(input: string) {
  const raw = String(input || '').trim()
  const value = /^(?:(?:www|m)\.)?(?:youtube\.com|youtu\.be)\//i.test(raw) ? 'https://' + raw : raw
  let url: URL
  try { url = new URL(value) }
  catch { throw new AppError('invalid_youtube_url', '请粘贴 YouTube 单个视频链接') }
  const host = url.hostname.toLowerCase()
  if (!['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'].includes(host) ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new AppError('invalid_youtube_url', '只接受 YouTube 单视频链接')
  }
  let id = ''
  if (host === 'youtu.be') {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || ''
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v') || ''
  } else {
    id = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || ''
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new AppError('invalid_youtube_url', '不支持频道、播放列表或无效视频 ID')
  }
  return { id, url: `https://www.youtube.com/watch?v=${id}`, shareId: `youtube:${id}` }
}

export function isYoutubeVideoUrl(value: string) {
  try { normalizeYoutubeUrl(value); return true } catch { return false }
}

function getDownloadableFormat(info: Record<string, unknown>) {
  const items = Array.isArray(info.requested_downloads) ? info.requested_downloads : []
  const formats = Array.isArray(info.formats) ? info.formats : []
  const candidates: unknown[] = [...items, info, ...formats]
  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const format = item as Record<string, unknown>
    if (typeof format.url !== 'string' || format.vcodec === 'none' || format.acodec === 'none') continue
    if (!format.vcodec || !format.acodec) continue
    const extension = String(format.ext || '')
    if (!['mp4', 'webm'].includes(extension)) continue
    if (format.protocol && format.protocol !== 'https') continue
    let parsed: URL
    try { parsed = new URL(format.url) } catch { continue }
    if (parsed.protocol !== 'https:' || !(/^(?:[a-z0-9-]+\.)*googlevideo\.com$/i.test(parsed.hostname))) continue
    return { url: format.url, extension }
  }
  throw new AppError('youtube_no_progressive', '没有可用的含音频 MP4 视频直链；本版本暂不合并分离音视频')
}

export function parseYoutubeInfo(json: string, source: ReturnType<typeof normalizeYoutubeUrl>): YoutubeVideo {
  let info: Record<string, unknown>
  try { info = JSON.parse(json) as Record<string, unknown> }
  catch { throw new AppError('youtube_parse_failed', 'yt-dlp 返回了无效 JSON') }
  if (!info || typeof info !== 'object' || Array.isArray(info) || Array.isArray(info.entries)) {
    throw new AppError('youtube_parse_failed', '不支持播放列表结果')
  }
  if (info.id !== source.id) throw new AppError('youtube_parse_failed', '解析视频 ID 与输入不一致')
  const media = getDownloadableFormat(info)
  const file: QuarkFile = {
    fid: source.shareId,
    name: `youtube_${source.id}.${media.extension}`,
    isDir: false,
    size: 0,
    createdAt: ''
  }
  return { ...source, file, mediaUrl: media.url }
}

async function resolveYtdlpExecutable() {
  const configured = String(process.env.YTDLP_PATH || '').trim()
  if (configured) return configured
  const desktopRoot = String(process.env.QUARK_DESKTOP_ROOT || '').trim()
  const resourcesPath = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '').trim()
  const resourceRelativePath = process.platform === 'win32' ? path.join('win', 'yt-dlp.exe') : path.join('linux', 'yt-dlp')
  const candidates = [
    path.resolve(process.cwd(), 'resources', 'yt-dlp', resourceRelativePath),
    desktopRoot ? path.resolve(desktopRoot, 'resources', 'yt-dlp', resourceRelativePath) : '',
    resourcesPath ? path.resolve(resourcesPath, 'yt-dlp', resourceRelativePath) : ''
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate }
    catch { /* try next candidate */ }
  }
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
}

export async function extractYoutubeVideo(input: string): Promise<YoutubeVideo> {
  const source = normalizeYoutubeUrl(input)
  const executable = await resolveYtdlpExecutable()
  let stdout: string
  try {
    const result = await run(executable, [
      '--ignore-config', '--no-playlist', '--no-warnings', '-J',
      '-f', 'b[ext=mp4]/b', source.url
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    const ex = error as NodeJS.ErrnoException & { killed?: boolean }
    if (ex.code === 'ENOENT') throw new AppError('dependency_missing', '未安装 yt-dlp 或未设置 YTDLP_PATH')
    if (ex.code === 'ETIMEDOUT' || ex.killed) throw new AppError('media_extract_timeout', 'YouTube 视频解析超时')
    throw new AppError('youtube_parse_failed', 'YouTube 视频解析失败，请检查网络、年龄限制或更新 yt-dlp')
  }
  return parseYoutubeInfo(stdout, source)
}
