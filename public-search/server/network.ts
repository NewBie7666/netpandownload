import https from 'node:https'
import dns from 'node:dns'
import { AppError } from '../../server/http.js'
import type { SearchTransport } from '../../server/search-core/codeSearch.js'

const hosts = new Set(['www.javbus.com', 'bitsearch.eu', 'nyaa.si', 'academictorrents.com'])

export function isPublicIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return false
  const [a, b, c] = parts
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113))
}

export function validateSourceUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) {
    throw new AppError('source_unavailable', '搜索源暂时不可用', 502)
  }
  return url
}

// Pin the actual connection to a checked public IPv4 address. No ambient cookies,
// proxy settings, arbitrary source URL, decompression, or private-network redirects.
export const publicTransport: SearchTransport = async (raw, options) => {
  const initial = validateSourceUrl(raw)
  const deadline = Date.now() + Math.min(options.timeoutMs, 12000)
  async function read(url: URL, redirects: number): Promise<{ status: number; html: string }> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new AppError('source_timeout', '搜索源响应超时', 502)
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const request = https.get(url, {
        agent: false,
        family: 4,
        headers: { 'User-Agent': 'NetPanDownload Public Search/1.0', ...options.headers, 'Accept-Encoding': 'identity' },
        lookup: (hostname, _options, callback) => {
          dns.lookup(hostname, { family: 4, all: true }, (error, answers) => {
            if (error) { callback(error, '', 4); return }
            if (!answers.length || answers.some(answer => !isPublicIPv4(answer.address))) {
              callback(new Error('Source address rejected'), '', 4); return
            }
            callback(null, answers[0].address, 4)
          })
        }
      }, response => {
        const status = response.statusCode || 502
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy()
          clearTimeout(timer)
          try {
            const next = validateSourceUrl(new URL(response.headers.location || '', url).href)
            if (next.hostname !== initial.hostname || redirects >= 2) throw new Error('redirect rejected')
            resolve(read(next, redirects + 1))
          } catch { reject(new AppError('source_unavailable', '搜索源暂时不可用', 502)) }
          return
        }
        if (status === 404 && url.hostname === 'www.javbus.com') {
          response.destroy(); clearTimeout(timer); resolve({ status, html: '' }); return
        }
        if (status < 200 || status >= 300 ||
            Number(response.headers['content-length'] || 0) > options.maxBytes ||
            (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy(); clearTimeout(timer)
          reject(new AppError('source_unavailable', '搜索源暂时不可用', 502)); return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > options.maxBytes) {
            request.destroy(new Error('Source response too large'))
          } else chunks.push(chunk)
        })
        response.on('end', () => { clearTimeout(timer); resolve({ status, html: Buffer.concat(chunks).toString('utf8') }) })
        response.on('error', error => { clearTimeout(timer); reject(error) })
      })
      timer = setTimeout(() => request.destroy(new Error('Source timeout')), remaining)
      request.on('error', error => { clearTimeout(timer); reject(error) })
    })
  }
  return read(initial, 0)
}
