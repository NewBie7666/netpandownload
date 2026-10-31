import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { isPublicIp } from '../downloader/directDownload.js'
import { AppError } from '../http.js'

export function validateVideoSourceUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || !value.trim()) {
    throw new AppError('video_source_invalid_url', '请输入有效的影视 API 地址')
  }
  let url: URL
  try { url = new URL(value.trim()) }
  catch { throw new AppError('video_source_invalid_url', '影视 API URL 格式错误') }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !hostname || (!hostname.includes('.') && !isIP(hostname)) ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(hostname) ||
      (isIP(hostname) && !isPublicIp(hostname))) {
    throw new AppError('video_source_invalid_url', '只允许公开互联网 HTTP/HTTPS 影视源地址', 400)
  }
  if (url.port && (Number(url.port) !== 80 && Number(url.port) !== 443)) {
    throw new AppError('video_source_invalid_port', '影视源只允许 HTTP 80 或 HTTPS 443 端口', 400)
  }
  url.hash = ''
  return url
}

async function oneRequest(url: URL): Promise<{ status: number, text: string, location: string }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: Array<{ address: string, family: number }>
  try { addresses = await lookup(hostname, { all: true, verbatim: true }) }
  catch { throw new AppError('video_source_dns_failed', '无法解析影视源域名', 502) }
  if (!addresses.length || addresses.some(address => !isPublicIp(address.address))) {
    throw new AppError('video_source_private_address', '影视源指向私网/保留地址，已拒绝', 403)
  }
  const address = addresses[0]
  // Pin the actual connection to the validated DNS answer, avoiding a second resolver lookup.
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'NetPanDownload-VideoSource/1.0',
        'Accept-Encoding': 'identity'
      },
      lookup: (_hostname: string, _options: unknown, callback: any) => callback(null, address.address, address.family),
      timeout: 8000,
      maxHeaderSize: 16384
    }, res => {
      const status = res.statusCode || 0
      const location = String(res.headers.location || '')
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume()
        resolve({ status, text: '', location })
        return
      }
      if (status < 200 || status > 299) {
        res.resume()
        reject(new AppError('video_source_http_error', '影视源返回 HTTP ' + status, 502))
        return
      }
      const type = String(res.headers['content-type'] || '')
      if (/text\/html/i.test(type)) {
        res.resume()
        reject(new AppError('video_source_bad_response', '影视源返回 HTML，不是 MacCMS JSON', 502))
        return
      }
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1_500_000) {
          res.destroy(new AppError('video_source_too_large', '影视源响应超出 1.5MB 限制', 413))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8'), location: '' }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new AppError('video_source_timeout', '影视源请求超时', 504)))
    req.on('error', reject)
    req.end()
  })
}

export async function fetchVideoSourceJson(initial: string): Promise<unknown> {
  let url = validateVideoSourceUrl(initial)
  for (let redirect = 0; redirect <= 2; redirect++) {
    const response = await oneRequest(url)
    if (response.location) {
      if (redirect === 2) throw new AppError('video_source_redirect', '影视源跳转超过 2 次', 502)
      url = validateVideoSourceUrl(new URL(response.location, url).toString())
      continue
    }
    try { return JSON.parse(response.text) as unknown }
    catch { throw new AppError('video_source_bad_response', '影视源未返回有效 JSON', 502) }
  }
  throw new AppError('video_source_redirect', '影视源跳转错误', 502)
}
