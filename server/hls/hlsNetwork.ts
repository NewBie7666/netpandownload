import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { isPublicIp } from '../downloader/directDownload.js'
import { AppError } from '../http.js'
import { validateVideoSourceUrl } from '../video-sources/network.js'

/** Resolve and pin all HLS HTTP requests (manifest, segment, AES key, redirect).
 * Never forward authentication/cookies from the calling user.
 */
export async function readHlsResource(
  input: string, maxBytes: number, signal?: AbortSignal, referer?: string
): Promise<{ data: Buffer, url: string }> {
  let url = validateVideoSourceUrl(input)
  const safeRef = referer ? validateVideoSourceUrl(referer).toString() : undefined
  for (let hop = 0; hop <= 3; hop++) {
    if (signal?.aborted) throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    let answers: Array<{ address: string, family: number }>
    try { answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }) }
    catch { throw new AppError('hls_dns_failed', 'HLS 域名解析失败', 502) }
    if (!answers.length || answers.some(a => !isPublicIp(a.address))) {
      throw new AppError('hls_private_address', 'HLS 地址指向私网或保留地址，已阻止', 403)
    }
    const pin = answers[0]
    const response = await new Promise<{ bytes: Buffer, location: string }>((resolve, reject) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25_000)
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const finish = () => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
      }
      const done = (value: { bytes: Buffer, location: string }) => { finish(); resolve(value) }
      const fail = (error: Error) => { finish(); reject(error) }
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
      const req = transport(url, {
        signal: controller.signal,
        timeout: 12_000,
        maxHeaderSize: 16_384,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NetPanDownload-HLS/1.0)',
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          ...(safeRef ? { Referer: safeRef } : {})
        },
        lookup: (_host: string, _options: unknown, callback: any) => callback(null, pin.address, pin.family)
      }, res => {
        const status = res.statusCode || 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = Array.isArray(res.headers.location) ? '' : String(res.headers.location || '')
          res.resume()
          if (!location) { fail(new AppError('hls_redirect', 'HLS 跳转缺少 Location', 502)); return }
          done({ bytes: Buffer.alloc(0), location })
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          fail(new AppError('hls_http_error', 'HLS 源站返回 HTTP ' + status, 502))
          return
        }
        if (Number(res.headers['content-length'] || 0) > maxBytes) {
          res.destroy(new AppError('hls_resource_too_large', 'HLS 分片超过单个资源上限', 413))
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        res.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > maxBytes) { res.destroy(new AppError('hls_resource_too_large', 'HLS 分片超过单个资源上限', 413)); return }
          chunks.push(chunk)
        })
        res.on('end', () => done({ bytes: Buffer.concat(chunks), location: '' }))
        res.on('error', fail)
      })
      req.on('timeout', () => req.destroy(new AppError('hls_timeout', 'HLS 请求超时', 504)))
      req.on('error', fail)
      req.end()

    })
    if (response.location) {
      if (hop === 3) throw new AppError('hls_redirect', 'HLS 重定向超过 3 次', 502)
      url = validateVideoSourceUrl(new URL(response.location, url).toString())
      continue
    }
    return { data: response.bytes, url: url.toString() }
  }
  throw new AppError('hls_redirect', 'HLS 跳转失败', 502)
}
