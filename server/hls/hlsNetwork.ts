import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { isPublicIp } from '../downloader/directDownload.js'
import { AppError } from '../http.js'
import { routesFor, tunnel, validateVideoSourceUrl } from '../video-sources/network.js'
import { preferIpv4, type SourceRoute } from '../video-sources/proxyRoute.js'

export interface PinnedHlsAddress { address: string; family: number }

/**
 * Node 22 may call lookup(host, {all: true}, cb) for auto-family selection.
 * In that case the callback must receive [{address,family}] — returning a
 * scalar address triggers ERR_INVALID_IP_ADDRESS / "Invalid IP address: undefined".
 * The callback never performs a second DNS query; the IP was validated first.
 */
export function createPinnedHlsLookup(pin: PinnedHlsAddress) {
  return (_hostname: string, options: { all?: boolean }, callback: any): void => {
    if (options?.all) callback(null, [{ address: pin.address, family: pin.family }])
    else callback(null, pin.address, pin.family)
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code || 'NETWORK_ERROR'
  return /^[A-Z0-9_]{2,60}$/i.test(code) ? code : 'NETWORK_ERROR'
}

async function resolvePublicAddresses(url: URL): Promise<PinnedHlsAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: PinnedHlsAddress[]
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true })
  } catch (e) {
    throw new AppError('hls_dns_failed', 'HLS 域名解析失败（' + errorCode(e) + '）', 502)
  }
  if (!addresses.length || addresses.some(ip => !isPublicIp(ip.address))) {
    throw new AppError('hls_private_address', 'HLS 清单/分片/密钥指向内网或保留地址，已阻止', 403)
  }
  return preferIpv4(addresses).slice(0, 8)
}

type ResourceResponse = { bytes: Buffer, location: string }
async function requestOne(
  url: URL, pin: PinnedHlsAddress, route: SourceRoute,
  maxBytes: number, signal?: AbortSignal, referer?: string
): Promise<ResourceResponse> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  const proxySocket = route.kind === 'proxy' ? await tunnel(route, pin.address, port) : undefined

  if (signal?.aborted) {
    proxySocket?.destroy()
    throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
  }

  return new Promise<ResourceResponse>((resolve, reject) => {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (watchdog) clearTimeout(watchdog)
      signal?.removeEventListener('abort', onAbort)
    }
    const succeed = (value: ResourceResponse) => {
      if (settled) return
      settled = true
      finish()
      resolve(value)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      finish()
      proxySocket?.destroy()
      reject(error)
    }
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = transport(url, {
      agent: false,
      // Keep a fixed, pre-validated DNS answer; do not let Node race families
      // with an unintended second resolution.
      ...({ autoSelectFamily: false } as Record<string, unknown>),
      lookup: createPinnedHlsLookup(pin),
      ...(proxySocket ? {
        createConnection: () => url.protocol === 'https:'
          ? connectTls({ socket: proxySocket, servername: hostname, rejectUnauthorized: true })
          : proxySocket
      } : {}),
      signal: controller.signal,
      timeout: 25_000,
      maxHeaderSize: 16_384,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NetPanDownload-HLS/1.0)',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        ...(referer ? { Referer: referer } : {})
      }
    }, res => {
      const status = res.statusCode || 0
      const location = Array.isArray(res.headers.location) ? '' : String(res.headers.location || '')
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume()
        if (!location) { fail(new AppError('hls_redirect', 'HLS 重定向缺少 Location', 502)); return }
        succeed({ bytes: Buffer.alloc(0), location })
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        fail(new AppError('hls_http_error', 'HLS 服务器返回 HTTP ' + status, 502))
        return
      }
      res.on('error', fail)
      if (Number(res.headers['content-length'] || 0) > maxBytes) {
        res.destroy(new AppError('hls_resource_too_large', 'HLS 分片/清单超出大小限制', 413))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (part: Buffer) => {
        size += part.length
        if (size > maxBytes) {
          res.destroy(new AppError('hls_resource_too_large', 'HLS 分片/清单超出大小限制', 413))
          return
        }
        chunks.push(part)
      })
      res.on('end', () => succeed({ bytes: Buffer.concat(chunks), location: '' }))
    })
    watchdog = setTimeout(() => controller.abort(), 45_000)
    req.on('timeout', () => req.destroy(new AppError('hls_timeout', 'HLS 请求超时', 504)))
    req.on('error', error => {
      if (signal?.aborted) fail(new AppError('hls_aborted', 'HLS 下载已中止', 409))
      else if (controller.signal.aborted) fail(new AppError('hls_timeout', 'HLS 请求超时', 504))
      else fail(error)
    })
    req.end()
  })
}

/**
 * Fetch a single playlist, TS fragment or AES key. Every URL (including a
 * redirected target) is checked against public DNS and pinned before connect.
 * Electron system-proxy/PAC routes are honored for HLS, as for TVBox import.
 */
export async function readHlsResource(
  input: string, maxBytes: number, signal?: AbortSignal, referer?: string
): Promise<{ data: Buffer, url: string }> {
  let url = validateVideoSourceUrl(input)
  const safeReferer = referer ? validateVideoSourceUrl(referer).toString() : undefined
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) {
    throw new AppError('hls_invalid_limit', 'HLS 单资源大小限制无效', 400)
  }
  for (let hop = 0; hop <= 3; hop++) {
    if (signal?.aborted) throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
    const addresses = await resolvePublicAddresses(url)
    const routes = await routesFor(url)
    let lastError: unknown
    let response: ResourceResponse | undefined
    for (const route of routes) {
      for (const address of addresses) {
        if (signal?.aborted) throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
        try {
          response = await requestOne(url, address, route, maxBytes, signal, safeReferer)
          break
        } catch (error) {
          // A rejected HTTP response, an over-limit response, abort or TLS
          // validation failure must not be bypassed by trying other IPs.
          if (error instanceof AppError &&
              !['hls_timeout'].includes(error.error)) throw error
          const code = errorCode(error)
          if (code.startsWith('ERR_TLS_') || code.startsWith('CERT_') ||
              code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
              code === 'DEPTH_ZERO_SELF_SIGNED_CERT') throw error
          lastError = error
        }
      }
      if (response) break
    }
    if (!response) {
      throw new AppError('hls_connection_failed',
        'HLS 清单/分片连接失败（' + errorCode(lastError) +
        '），已尝试可用的 IPv4/IPv6 与系统代理线路', 502)
    }
    if (response.location) {
      if (hop === 3) throw new AppError('hls_redirect', 'HLS 跳转超过 3 次', 502)
      url = validateVideoSourceUrl(new URL(response.location, url).toString())
      continue
    }
    return { data: response.bytes, url: url.toString() }
  }
  throw new AppError('hls_redirect', 'HLS 跳转错误', 502)
}
