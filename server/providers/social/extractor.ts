import { request } from 'node:https'
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib'
import { readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AppError } from '../../http.js'
import { lookupPublicAddresses } from '../../downloader/pageLinkScanner.js'
import { extractSocialSource, normalizeSocialPageUrl } from './source.js'
import { parseSocialPostHtml, parseSocialYtdlpJson } from './metadataParser.js'
import { socialPageUserAgent } from './mediaPolicy.js'
import type { SocialMedia, SocialPlatform, SocialPost, SocialSource } from './types.js'
import { extractAuthenticatedDouyin } from './douyinBrowser.js'
import { socialPageHosts } from '../../../shared/socialLinks.js'
import { managedDouyinCookieHeader, withDouyinCookieFile } from '../../auth/douyin/credentials.js'

export interface SocialPage { status: number; location?: string; html: string }
export interface SocialExtractOptions {
  requestPage?: (url: string) => Promise<SocialPage>
  runYtdlp?: (platform: SocialPlatform, source: SocialSource) => Promise<string>
  requestDouyinBrowser?: (source: SocialSource) => Promise<SocialMedia[] | undefined>
}
const MAX_BYTES = 8 * 1024 * 1024
const run = promisify(execFile)

function cookieFile(platform: SocialPlatform) {
  const file = String(process.env[platform === 'douyin' ? 'DOUYIN_COOKIE_FILE' : 'XIAOHONGSHU_COOKIE_FILE'] || '').trim()
  if (file && !path.isAbsolute(file)) throw new AppError('auth_required', '平台 Cookie 文件必须由管理员配置为绝对路径')
  return file
}

async function cookiesFor(url: URL, platform: SocialPlatform): Promise<string> {
  if (platform === 'douyin') {
    const managed = await managedDouyinCookieHeader(url)
    if (managed !== undefined) return managed
  }
  const file = cookieFile(platform)
  if (!file) return ''
  let content: string
  try { content = await readFile(file, 'utf8') } catch { throw new AppError('auth_required', '无法读取平台 Cookie 文件，请管理员检查配置') }
  if (Buffer.byteLength(content) > 256 * 1024) throw new AppError('auth_required', '平台 Cookie 文件过大')
  const cookies: string[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/^#HttpOnly_/, '')
    if (!line || line.startsWith('#')) continue
    const fields = line.split('\t')
    if (fields.length !== 7) continue
    const [domain, includeSubdomains, cookiePath, , expiry, name, value] = fields
    const host = domain.toLowerCase().replace(/^\./, '')
    const matches = url.hostname === host || (includeSubdomains === 'TRUE' && url.hostname.endsWith('.' + host))
    if (!matches || (Number(expiry) > 0 && Number(expiry) * 1000 <= Date.now())) continue
    if (!url.pathname.startsWith(cookiePath) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;]/.test(value)) continue
    cookies.push(`${name}=${value}`)
  }
  return cookies.join('; ')
}

export async function requestSocialPage(input: string): Promise<SocialPage> {
  const candidate = new URL(input)
  const platform = (Object.keys(socialPageHosts) as SocialPlatform[]).find(key => socialPageHosts[key].includes(candidate.hostname))
  if (!platform) throw new AppError('social_invalid_url', '不支持的分享网址')
  const url = new URL(normalizeSocialPageUrl(input, platform))
  const cookie = await cookiesFor(url, platform)
  return new Promise((resolve, reject) => {
    const req = request(url, {
      timeout: 12000,
      headers: {
        'User-Agent': socialPageUserAgent(platform),
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(cookie ? { Cookie: cookie } : {})
      },
      lookup: (hostname, options, callback) => {
        void lookupPublicAddresses(hostname).then(addresses => {
          if (options.all) callback(null, addresses, 0)
          else callback(null, addresses[0].address, addresses[0].family)
        }, () => callback(new Error('platform DNS rejected'), '', 0))
      }
    }, response => {
      const status = response.statusCode || 0
      if (status !== 200) {
        response.resume()
        resolve({ status, location: response.headers.location, html: '' })
        return
      }
      if (!/text\/html|application\/xhtml\+xml/i.test(String(response.headers['content-type'] || ''))) {
        response.resume()
        reject(new AppError('social_parse_failed', '分享链接没有返回作品网页'))
        return
      }
      const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase()
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined
      if (!decoder && encoding !== 'identity') { response.resume(); reject(new AppError('social_parse_failed', '平台网页使用不支持的编码')); return }
      let rawBytes = 0
      response.on('data', (part: Buffer) => {
        rawBytes += part.length
        if (rawBytes > MAX_BYTES) response.destroy(new AppError('social_parse_failed', '平台网页过大，已停止解析'))
      })
      const stream = decoder ? response.pipe(decoder) : response
      const chunks: Buffer[] = []
      let decodedBytes = 0
      stream.on('data', (part: Buffer) => {
        decodedBytes += part.length
        if (decodedBytes > MAX_BYTES) {
          response.destroy()
          stream.destroy(new AppError('social_parse_failed', '解压后的平台网页过大，已停止解析'))
        } else chunks.push(Buffer.from(part))
      })
      stream.on('end', () => resolve({ status, html: Buffer.concat(chunks).toString('utf8') }))
      stream.on('error', () => reject(new AppError('social_parse_failed', '读取平台网页失败，请稍后重试')))
      response.on('error', () => { decoder?.destroy(); reject(new AppError('network_error', '平台网页传输中断')) })
    })
    const deadline = setTimeout(() => req.destroy(new Error('deadline')), 15000)
    req.once('close', () => clearTimeout(deadline))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => reject(new AppError('network_error', '无法连接平台网页，请检查网络或稍后重试', 502)))
    req.end()
  })
}

async function ytDlpPath() {
  const configured = String(process.env.YTDLP_PATH || '').trim()
  if (configured) return configured
  const resources = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '')
  const relative = process.platform === 'win32' ? ['win', 'yt-dlp.exe'] : ['linux', 'yt-dlp']
  for (const root of [path.join(process.cwd(), 'resources'), process.env.QUARK_DESKTOP_ROOT ? path.join(process.env.QUARK_DESKTOP_ROOT, 'resources') : '', resources]) {
    if (!root) continue
    const candidate = path.join(root, 'yt-dlp', ...relative)
    try { await access(candidate, constants.X_OK); return candidate } catch { /* next installed location */ }
  }
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
}

async function runSocialYtdlp(platform: SocialPlatform, source: SocialSource): Promise<string> {
  const invoke = async (file: string | undefined): Promise<string> => {
    const url = platform === 'douyin' ? `https://www.douyin.com/video/${source.id}` : source.url
    try {
      const result = await run(await ytDlpPath(), [
        '--ignore-config', '--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json',
        '--use-extractors', platform === 'douyin' ? 'Douyin' : 'XiaoHongShu',
        '--user-agent', socialPageUserAgent(platform),
        ...(file ? ['--cookies', file] : []), '-f', 'b[ext=mp4]/b', url
      ], { encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: MAX_BYTES })
      return result.stdout
    } catch (error) {
      const info = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
      if (info.code === 'ENOENT') throw new AppError('dependency_missing', '网页未返回可用媒体，且未安装 yt-dlp；请管理员检查依赖和平台登录状态')
      if (info.killed || info.code === 'ETIMEDOUT') throw new AppError('media_extract_timeout', '平台媒体解析超时，请稍后重试')
      if (/cookie|login|sign.?in|登录|验证/i.test(info.stderr || '')) throw new AppError('auth_required', platform === 'douyin' ? '抖音需要有效登录态或验证，请点击“登录抖音”扫码后重试' : '平台需要有效登录态或验证，请管理员检查平台登录配置')
      throw new AppError('blocked_by_upstream', '平台暂未提供可下载媒体，可能是链接过期、作品受限或平台风控；请重新复制分享链接')
    }
  }
  return platform === 'douyin'
    ? withDouyinCookieFile(cookieFile(platform) || undefined, invoke)
    : invoke(cookieFile(platform) || undefined)
}

export async function extractSocialPost(input: string, options: SocialExtractOptions = {}): Promise<SocialPost> {
  const original = extractSocialSource(input)
  let url = original.url
  const fetchPage = options.requestPage || requestSocialPage
  for (let redirect = 0; redirect <= 4; redirect++) {
    url = normalizeSocialPageUrl(url, original.platform)
    const page = await fetchPage(url)
    if (page.status >= 300 && page.status < 400) {
      if (redirect === 4 || !page.location) throw new AppError('social_redirect_forbidden', '分享短链跳转过多或缺少目标地址')
      try { url = normalizeSocialPageUrl(new URL(page.location, url).toString(), original.platform) }
      catch { throw new AppError('social_redirect_forbidden', '分享短链跳转到非受信任地址，已拒绝访问', 403) }
      continue
    }
    let source: SocialSource
    try { source = extractSocialSource(url, original.platform) }
    catch { throw new AppError('auth_required', '分享链接没有到达作品页面，可能需要登录；请重新复制完整分享链接') }
    if (!source.id) throw new AppError('social_parse_failed', '短链没有跳转到具体作品；请复制作品长链接后重试')
    if (page.status === 401) throw new AppError('auth_required', '平台要求有效登录态，请管理员检查平台 Cookie 配置')
    if (page.status === 403) throw new AppError('blocked_by_upstream', '平台拒绝访问，可能需要登录或验证，请重新分享或稍后重试', 403)
    if (page.status !== 200) throw new AppError('network_error', '平台网页请求失败，请稍后重试', 502)
    let media: SocialMedia[] | undefined
    try {
      media = parseSocialPostHtml(source.platform, page.html, source.id)
    } catch (error) {
      if (!(error instanceof AppError) || !['social_parse_failed', 'auth_required', 'blocked_by_upstream', 'restricted'].includes(error.error)) throw error
      if (source.platform === 'douyin' && (options.requestDouyinBrowser || (!options.requestPage && !options.runYtdlp))) {
        media = await (options.requestDouyinBrowser || extractAuthenticatedDouyin)(source)
      }
      if (!media?.length) {
        const json = await (options.runYtdlp || runSocialYtdlp)(source.platform, source)
        media = parseSocialYtdlpJson(source.platform, json, source.id)
      }
    }
    if (!media.length) throw new AppError('social_parse_failed', '未获得实际媒体地址，请重新复制分享链接')
    return { platform: source.platform, id: source.id, sourceUrl: source.url, media }
  }
  throw new AppError('social_redirect_forbidden', '分享短链跳转过多')
}
