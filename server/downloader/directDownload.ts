import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { AppError } from '../http.js'
import type { AddDirectDownloadRequest } from '../../shared/types.js'

export interface ValidatedDirectDownload {
  url: string
  fileName?: string
}

// DNS validation is defense in depth. Redirects and rebinding can occur after
// this check, so the downloader API must remain bound to loopback only.
type HostResolver = (hostname: string) => Promise<string[]>

function publicIp(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase()
  const family = isIP(normalized)
  if (family === 4) {
    const [a, b, c] = normalized.split('.').map(Number)
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (family === 6) {
    const first = Number.parseInt(normalized.split(':')[0], 16)
    return first >= 0x2000 && first < 0x4000 && !normalized.startsWith('2001:db8:')
  }
  return false
}

function parseDirectUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new AppError('invalid_direct_url', '请输入有效的 HTTP/HTTPS 文件下载地址')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new AppError('invalid_direct_url', '下载地址格式不正确')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError('invalid_direct_url', '仅支持不带账号密码的 HTTP/HTTPS 链接')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host || (!host.includes('.') && !isIP(host)) ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
      (isIP(host) && !publicIp(host))) {
    throw new AppError('direct_url_private_host', '不允许下载本机、局域网或保留地址')
  }
  url.hash = ''
  return url
}

function parseFileName(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    throw new AppError('invalid_direct_filename', '文件名必须是字符串')
  }
  const filename = value.trim()
  if (!filename || filename.length > 180 || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(filename) ||
      /^\.+$/.test(filename) || /[. ]$/.test(filename) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(filename)) {
    throw new AppError('invalid_direct_filename', '文件名包含非法字符、路径或 Windows 保留名称')
  }
  return filename
}

async function lookupAddresses(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true })
  return results.map((result) => result.address)
}

export async function validateDirectDownloadInput(
  input: unknown,
  resolver: HostResolver = lookupAddresses
): Promise<ValidatedDirectDownload> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('invalid_direct_url', '下载参数格式不正确')
  }
  const request = input as AddDirectDownloadRequest
  const url = parseDirectUrl(request.url)
  const fileName = parseFileName(request.fileName)

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!isIP(hostname)) {
    let addresses: string[]
    try {
      addresses = await resolver(hostname)
    } catch {
      throw new AppError('direct_url_dns_failed', '下载地址的域名解析失败，请检查网络或链接')
    }
    if (!addresses.length || addresses.some((address) => !publicIp(address))) {
      throw new AppError('direct_url_private_host', '域名指向本机、局域网或保留地址，已阻止下载')
    }
  }
  return { url: url.toString(), fileName }
}
