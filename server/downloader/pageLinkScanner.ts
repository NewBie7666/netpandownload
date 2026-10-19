import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { AppError } from '../http.js'
import { isPublicIp, validateDirectDownloadInput } from './directDownload.js'
import type { PageFileLink, ScanPageResult } from '../../shared/types.js'

export const MAX_PAGE_LINKS = 200
const MAX_HTML_BYTES = 1024 * 1024
const MAX_REDIRECTS = 4

export function parseExtensionFilter(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 240) {
    throw new AppError('invalid_extension_filter', '请输入要查找的文件后缀，例如 zip,pdf,mp4')
  }
  const tokens = value.toLowerCase().split(/[,，;\s]+/).map((s) => s.replace(/^\./, '').trim()).filter(Boolean)
  if (!tokens.length || tokens.length > 20 || tokens.some((s) => !/^[a-z0-9]{1,12}$/.test(s))) {
    throw new AppError('invalid_extension_filter', '后缀列表格式错误，最多 20 项，例如 zip,pdf,mp4')
  }
  return [...new Set(tokens)]
}

function decodeHtmlAttribute(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (token, key: string) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? token
    const hex = key[1]?.toLowerCase() === 'x'
    const num = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10)
    return Number.isInteger(num) && num > 0 && num <= 0x10ffff && !(num >= 0xd800 && num <= 0xdfff)
      ? String.fromCodePoint(num) : token
  })
}

function attrValue(tag: string, name: string): string | undefined {
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s>]+))', 'i')
  const match = tag.match(re)
  return match ? decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? '') : undefined
}

// Static anchor and media-source extraction only; no JS execution or recursive crawl.
export function extractFileLinks(html: string, pageUrl: string, extensions: string[]): Pick<ScanPageResult, 'items' | 'truncated'> {
  const baseTag = html.match(/<base\b[^>]{0,4000}>/i)?.[0]
  let base = pageUrl
  if (baseTag) {
    try {
      const candidate = new URL(attrValue(baseTag, 'href') || '', pageUrl)
      if (candidate.protocol === 'http:' || candidate.protocol === 'https:') base = candidate.toString()
    } catch { /* ignore invalid <base> */ }
  }

  const suffixes = new Set(extensions.map((ext) => ext.toLowerCase().replace(/^\./, '')))
  const seen = new Set<string>()
  const items: PageFileLink[] = []
  let truncated = false
  const tags = html.match(/<(?:a|img|video|audio|source)\b[^>]{0,8192}>/gi) || []

  for (const tag of tags) {
    const reference = attrValue(tag, /^<a\b/i.test(tag) ? 'href' : 'src')
    if (!reference) continue
    let link: URL
    try {
      link = new URL(reference, base)
      if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) continue
      link.hash = ''
    } catch { continue }
    let name: string
    try {
      name = decodeURIComponent(link.pathname.split('/').pop() || '')
    } catch { continue }
    // Never treat path traversal or an encoded slash as a filename.
    if (!name || /[/\\\x00-\x1f]/.test(name)) continue
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
    if (!suffixes.has(ext) || seen.has(link.toString())) continue
    seen.add(link.toString())
    if (items.length >= MAX_PAGE_LINKS) {
      truncated = true
      break
    }
    items.push({ url: link.toString(), fileName: name, extension: ext })
  }
  return { items, truncated }
}

interface PageResponse {
  status: number
  location?: string
  contentType: string
  text: string
}

export async function lookupPublicAddresses(
  hostname: string,
  resolver: (hostname: string) => Promise<LookupAddress[]> = (host) => lookup(host, { all: true })
): Promise<LookupAddress[]> {
  const addresses = await resolver(hostname)
  if (!addresses.length || addresses.some((item) => !item.address || !isPublicIp(item.address))) {
    throw new AppError('page_scan_private_dns', '网页域名解析到本地或私有地址，已拒绝连接', 403)
  }
  return addresses
}

function requestHtml(url: string): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? httpsRequest : httpRequest
    const req = transport(url, {
      timeout: 12000,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'identity',
        'User-Agent': 'NetpanDownload/1.0 (+static link scan)'
      },
      // Recheck the actual connection address to resist DNS rebinding between
      // validation and transport. The callback never accepts a private IP.
      lookup: (hostname, options, callback) => {
        // Node's HTTP client can request { all: true }; that callback MUST
        // receive LookupAddress[], not one string. The former code broke here.
        void lookupPublicAddresses(hostname).then((addresses) => {
          if (options.all) callback(null, addresses, 0)
          else callback(null, addresses[0].address, addresses[0].family)
        }, (error) => {
          callback(error instanceof Error ? error : new Error(String(error)), '', 0)
        })
      }
    }, (response) => {
      const status = response.statusCode || 0
      const location = response.headers.location
      const contentType = String(response.headers['content-type'] || '').toLowerCase()
      if (status >= 300 && status < 400) {
        response.resume()
        resolve({ status, location, contentType, text: '' })
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new AppError('page_scan_http_error', '网页请求失败：HTTP ' + status, 502))
        return
      }
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        response.resume()
        reject(new AppError('page_scan_not_html', '链接返回的不是 HTML 网页', 400))
        return
      }
      if (String(response.headers['content-encoding'] || 'identity').toLowerCase() !== 'identity') {
        response.resume()
        reject(new AppError('page_scan_encoding', '网页返回压缩内容且不支持原始 HTML 读取', 400))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (part: Buffer) => {
        total += part.length
        if (total > MAX_HTML_BYTES) {
          response.destroy(new AppError('page_scan_too_large', '网页 HTML 超过 1MB，已停止扫描', 413))
          return
        }
        chunks.push(Buffer.from(part))
      })
      response.on('end', () => resolve({
        status, contentType, text: Buffer.concat(chunks).toString('utf8')
      }))
      response.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new AppError('page_scan_timeout', '抓取网页超时（12 秒）', 504)))
    req.on('error', (error) => reject(error instanceof AppError ? error : new AppError('page_scan_failed', '网页请求失败：' + error.message, 502)))
    req.end()
  })
}

export async function scanPageForFiles(
  input: unknown,
  fetcher: (url: string) => Promise<PageResponse> = requestHtml
): Promise<ScanPageResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('invalid_page_scan', '请输入有效的网页链接和文件后缀')
  }
  const request = input as { url?: unknown, extensions?: unknown }
  const extensions = parseExtensionFilter(request.extensions)
  let currentUrl = (await validateDirectDownloadInput({ url: request.url })).url
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const page = await fetcher(currentUrl)
    if (page.status >= 300 && page.status < 400) {
      if (redirects === MAX_REDIRECTS || !page.location) {
        throw new AppError('page_scan_redirect', '网页跳转次数过多或无有效跳转地址')
      }
      const target = new URL(page.location, currentUrl).toString()
      currentUrl = (await validateDirectDownloadInput({ url: target })).url
      continue
    }
    if (page.status < 200 || page.status >= 300) {
      throw new AppError('page_scan_http_error', '网页请求失败：HTTP ' + page.status, 502)
    }
    if (!/text\/html|application\/xhtml\+xml/.test(page.contentType)) {
      throw new AppError('page_scan_not_html', '链接返回的不是 HTML 网页')
    }
    const { items, truncated } = extractFileLinks(page.text, currentUrl, extensions)
    return { pageUrl: currentUrl, extensions, items, truncated }
  }
  throw new AppError('page_scan_redirect', '网页跳转次数过多')
}
