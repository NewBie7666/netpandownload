import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { QuarkFile } from '../../../shared/types.js'
import { AppError } from '../../http.js'

const execFileAsync = promisify(execFile)
const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'webm'])
const MEDIA_HOSTS = ['cdninstagram.com', 'fbcdn.net']
const MAX_MEDIA_ITEMS = 50

export interface InstagramMedia {
  fid: string
  file: QuarkFile
  url: string
}

export interface InstagramPost {
  url: string
  kind: 'p' | 'reel' | 'tv'
  code: string
  shareId: string
  media: InstagramMedia[]
}

function isHost(host: string, suffix: string) {
  return host === suffix || host.endsWith('.' + suffix)
}

/** Only single Instagram posts are accepted: never profiles, stories, arbitrary hosts or local URLs. */
export function normalizeInstagramPost(input: string) {
  const trimmed = String(input || '').trim().replace(/^['"]|['"]$/g, '')
  const candidate = /^(?:www\.)?instagram\.com\//i.test(trimmed) ? 'https://' + trimmed : trimmed
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new AppError('invalid_instagram_url', '请输入 Instagram 单个帖子链接（/p/、/reel/ 或 /tv/）')
  }
  const host = parsed.hostname.toLowerCase()
  if (!['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(host) ||
      !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
    throw new AppError('invalid_instagram_url', '只接受 instagram.com 的单个帖子链接')
  }
  const match = /^\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/.exec(parsed.pathname)
  if (!match) {
    throw new AppError('invalid_instagram_url', '仅支持单个 /p/、/reel/ 或 /tv/ 链接，不支持主页及限时动态')
  }
  const kind = match[1] as InstagramPost['kind']
  const code = match[2]
  return { url: `https://www.instagram.com/${kind}/${code}/`, kind, code, shareId: `instagram:${kind}:${code}` }
}

export function isInstagramPostUrl(input: string) {
  try {
    normalizeInstagramPost(input)
    return true
  } catch {
    return false
  }
}

function isSafeMediaUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password &&
      MEDIA_HOSTS.some((h) => isHost(u.hostname.toLowerCase(), h))
  } catch {
    return false
  }
}

function extensionFor(meta: Record<string, unknown>, url: string): string {
  const fromMeta = typeof meta.extension === 'string' ? meta.extension.toLowerCase().replace(/^\./, '') : ''
  if (SUPPORTED_EXTENSIONS.has(fromMeta)) return fromMeta
  try {
    const end = new URL(url).pathname.match(/\.([a-z0-9]{2,6})$/i)?.[1]?.toLowerCase() || ''
    return SUPPORTED_EXTENSIONS.has(end) ? end : ''
  } catch {
    return ''
  }
}

/** gallery-dl -J produces an array of [messageType, url, metadata] tuples. Type 3 is a media URL. */
export function parseInstagramGalleryJson(json: string, input: ReturnType<typeof normalizeInstagramPost>): InstagramPost {
  let messages: unknown
  try {
    messages = JSON.parse(json)
  } catch {
    throw new AppError('instagram_parse_failed', 'gallery-dl 返回了无法识别的 JSON')
  }
  if (!Array.isArray(messages)) {
    throw new AppError('instagram_parse_failed', 'gallery-dl 的解析结果不是媒体列表')
  }
  const result: InstagramMedia[] = []
  let failed = false
  for (const item of messages) {
    if (!Array.isArray(item)) continue
    if (item[0] === -1) failed = true
    if (item[0] !== 3 || typeof item[1] !== 'string') continue
    const url = item[1]
    if (!isSafeMediaUrl(url)) {
      throw new AppError('instagram_parse_failed', 'Instagram 返回了非受信任的媒体地址，已拒绝下载')
    }
    const meta = item[2] && typeof item[2] === 'object' && !Array.isArray(item[2])
      ? item[2] as Record<string, unknown> : {}
    const ext = extensionFor(meta, url)
    if (!ext) {
      throw new AppError('instagram_parse_failed', '解析到不支持的媒体格式，未生成虚假下载项')
    }
    if (result.length >= MAX_MEDIA_ITEMS) {
      throw new AppError('instagram_parse_failed', '单帖媒体数量超过安全上限')
    }
    const ordinal = String(result.length + 1).padStart(2, '0')
    const name = `instagram_${input.code}_${ordinal}.${ext}`
    const numericSize = typeof meta.filesize === 'number' ? meta.filesize : typeof meta.size === 'number' ? meta.size : 0
    const file: QuarkFile = {
      fid: `${input.shareId}:${ordinal}`,
      name,
      size: Number.isFinite(numericSize) && numericSize > 0 ? numericSize : 0,
      isDir: false,
      createdAt: ''
    }
    result.push({ fid: file.fid, file, url })
  }
  // A partly failed extraction is not a valid complete carousel; never silently report success.
  if (failed) {
    throw new AppError('instagram_parse_failed', 'Instagram 只返回了部分资源，请更新 gallery-dl 或检查登录状态')
  }
  if (!result.length) {
    throw new AppError('instagram_parse_failed', '未解析出图片或视频。内容可能需要登录、已删除或受到 Instagram 限制')
  }
  return { ...input, media: result }
}

function candidateBinaries() {
  const configured = String(process.env.GALLERY_DL_PATH || '').trim()
  const resourcesPath = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '').trim()
  const desktopRoot = String(process.env.QUARK_DESKTOP_ROOT || '').trim()
  const filename = process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl'
  return { paths: [...new Set([
    configured,
    path.resolve(process.cwd(), 'resources', 'gallery-dl', 'win', 'gallery-dl.exe'),
    resourcesPath && path.resolve(resourcesPath, 'gallery-dl', 'win', 'gallery-dl.exe'),
    desktopRoot && path.resolve(desktopRoot, 'resources', 'gallery-dl', 'win', 'gallery-dl.exe')
  ].filter(Boolean))], fallback: filename }
}

async function findBinary() {
  const { paths, fallback } = candidateBinaries()
  for (const candidate of paths) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch { /* try next */ }
  }
  return fallback
}

export async function extractInstagramPost(input: string): Promise<InstagramPost> {
  const post = normalizeInstagramPost(input)
  const executable = await findBinary()
  const args = ['--config-ignore', '--no-input', '-J']
  // Explicit opt-in. Keep cookies in local files; never send them to the frontend/logs.
  const cookies = String(process.env.INSTAGRAM_COOKIES_FILE || '').trim()
  if (cookies) args.push('--cookies', cookies)
  args.push(post.url)
  let stdout: string
  try {
    const response = await execFileAsync(executable, args, {
      encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true
    })
    stdout = response.stdout
  } catch (error) {
    const ex = error as NodeJS.ErrnoException & { killed?: boolean }
    if (ex.code === 'ENOENT') {
      throw new AppError('dependency_missing', '未找到 gallery-dl：请安装它或设置 GALLERY_DL_PATH')
    }
    if (ex.code === 'ETIMEDOUT' || ex.killed) {
      throw new AppError('media_extract_timeout', 'Instagram 解析超时，请稍后重试')
    }
    throw new AppError('instagram_parse_failed', 'Instagram 解析失败：请检查网络、Cookies 或更新 gallery-dl')
  }
  return parseInstagramGalleryJson(stdout, post)
}
