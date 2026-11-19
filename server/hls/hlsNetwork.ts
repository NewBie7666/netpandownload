import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { isPublicIp } from '../downloader/directDownload.js'
import { AppError } from '../http.js'
import { routesFor, tunnel, validateVideoSourceUrl } from '../video-sources/network.js'
import { preferIpv4, type SourceRoute } from '../video-sources/proxyRoute.js'
import type { HlsByteRange } from './hlsParser.js'
import { normalizeMediaHeaders } from '../video-sources/mediaHeaders.js'

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

function validatePinnedAddresses(addresses: PinnedHlsAddress[]): PinnedHlsAddress[] {
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(pin =>
    !pin || !isIP(pin.address) || ![4, 6].includes(pin.family) || isIP(pin.address) !== pin.family ||
    !isPublicIp(pin.address)
  )) {
    throw new AppError('hls_private_address', 'HLS 清单/分片/密钥指向内网或保留地址，已阻止', 403)
  }
  return preferIpv4(addresses).slice(0, 8)
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
  return validatePinnedAddresses(addresses)
}

type ResourceResponse = {
  bytes: Buffer
  location: string
  statusCode: number
  headers: Record<string, string | string[] | undefined>
}

type HlsAddressResolver = (url: URL) => Promise<PinnedHlsAddress[]>
type HlsRouteResolver = (url: URL) => Promise<SourceRoute[]>
type HlsRequestOne = (
  url: URL,
  pin: PinnedHlsAddress,
  route: SourceRoute,
  maxBytes: number,
  signal?: AbortSignal,
  referer?: string,
  byteRange?: HlsByteRange,
  headers?: Record<string, string>
) => Promise<ResourceResponse>

function validateByteRange(byteRange: HlsByteRange | undefined, maxBytes: number): HlsByteRange | undefined {
  if (byteRange === undefined) return undefined
  if (!byteRange || !Number.isSafeInteger(byteRange.offset) || byteRange.offset < 0 ||
      !Number.isSafeInteger(byteRange.length) || byteRange.length < 1 || byteRange.length > maxBytes ||
      byteRange.offset > Number.MAX_SAFE_INTEGER - byteRange.length + 1) {
    throw new AppError('hls_invalid_range', 'HLS 字节区间无效或超出单资源限制', 400)
  }
  return { offset: byteRange.offset, length: byteRange.length }
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const lowerName = name.toLowerCase()
  const actualName = Object.keys(headers).find(key => key.toLowerCase() === lowerName)
  const value = actualName ? headers[actualName] : undefined
  return Array.isArray(value) ? value[0] : value
}

function responseError(status: number): AppError {
  if (status === 403 || status === 404) {
    return new AppError('hls_http_error',
      'HLS 服务器返回 HTTP ' + status + '；可能是链接访问权限、请求头、地区/IP 网络限制或源站拒绝', 502)
  }
  return new AppError('hls_http_error', 'HLS 服务器返回 HTTP ' + status, 502)
}

function validateResourceResponse(response: ResourceResponse, maxBytes: number, byteRange?: HlsByteRange): void {
  if (response.location) return
  const status = response.statusCode
  if (status < 200 || status >= 300) throw responseError(status)
  if (byteRange && status !== 206) {
    throw new AppError('hls_range_unsupported', 'HLS 服务器未按要求返回字节区间（需要 HTTP 206）', 502)
  }
  if (!byteRange && status === 206) {
    throw new AppError('hls_range_unexpected', 'HLS 服务器返回了未请求的字节区间', 502)
  }
  const encoding = headerValue(response.headers, 'content-encoding')?.trim().toLowerCase()
  if (encoding && encoding !== 'identity') {
    throw new AppError('hls_encoded_response', 'HLS 响应使用了不支持的 Content-Encoding', 502)
  }
  const declaredLength = headerValue(response.headers, 'content-length')
  if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new AppError('hls_resource_too_large', 'HLS 分片/清单超出大小限制', 413)
  }
  if (declaredLength !== undefined && Number(declaredLength) !== response.bytes.length) {
    throw new AppError('hls_content_length_mismatch', 'HLS 响应长度与 Content-Length 不一致', 502)
  }
  if (byteRange) {
    const expectedEnd = byteRange.offset + byteRange.length - 1
    const contentRange = headerValue(response.headers, 'content-range')?.trim() || ''
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange)
    if (!match) throw new AppError('hls_invalid_content_range', 'HLS 响应缺少有效的 Content-Range', 502)
    const start = Number(match[1])
    const end = Number(match[2])
    const total = match[3] === '*' ? undefined : Number(match[3])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== byteRange.offset ||
        end !== expectedEnd || end < start || (total !== undefined && (!Number.isSafeInteger(total) || total <= end))) {
      throw new AppError('hls_invalid_content_range', 'HLS 响应的 Content-Range 与请求区间不一致', 502)
    }
    if (response.bytes.length !== byteRange.length) {
      throw new AppError('hls_range_length_mismatch', 'HLS 字节区间响应长度不完整', 502)
    }
  }
  if (response.bytes.length > maxBytes) {
    throw new AppError('hls_resource_too_large', 'HLS 分片/清单超出大小限制', 413)
  }
}

async function requestOne(
  url: URL, pin: PinnedHlsAddress, route: SourceRoute,
  maxBytes: number, signal?: AbortSignal, referer?: string, byteRange?: HlsByteRange,
  mediaHeaders?: Record<string, string>
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
        ...mediaHeaders,
        ...(byteRange ? {
          Range: 'bytes=' + byteRange.offset + '-' + (byteRange.offset + byteRange.length - 1)
        } : {}),
        ...(referer ? { Referer: referer } : {})
      }
    }, res => {
      const status = res.statusCode || 0
      const location = Array.isArray(res.headers.location) ? '' : String(res.headers.location || '')
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume()
        if (!location) { fail(new AppError('hls_redirect', 'HLS 重定向缺少 Location', 502)); return }
        succeed({ bytes: Buffer.alloc(0), location, statusCode: status, headers: res.headers })
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        succeed({ bytes: Buffer.alloc(0), location: '', statusCode: status, headers: res.headers })
        return
      }
      if ((byteRange && status !== 206) || (!byteRange && status === 206)) {
        res.resume()
        succeed({ bytes: Buffer.alloc(0), location: '', statusCode: status, headers: res.headers })
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
      res.on('end', () => succeed({ bytes: Buffer.concat(chunks), location: '', statusCode: status, headers: res.headers }))
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
export interface HlsNetworkDependencies {
  /** Internal test seam. Returned addresses are still checked for public IPs. */
  resolvePublicAddresses?: HlsAddressResolver
  /** Internal test seam for deterministic route selection. */
  routesFor?: HlsRouteResolver
  /** Internal test seam for mocking HTTP responses without bypassing URL/DNS checks. */
  requestOne?: HlsRequestOne
}

/**
 * Build an HLS resource reader. The default reader below is the only production
 * entry point; dependency overrides exist for offline transport tests and still
 * enforce URL validation and public-address pinning.
 */
export function createHlsResourceReader(dependencies: HlsNetworkDependencies = {}) {
  const resolve = dependencies.resolvePublicAddresses || resolvePublicAddresses
  const routes = dependencies.routesFor || routesFor
  const request = dependencies.requestOne || requestOne
  return async function readHlsResource(
    input: string,
    maxBytes: number,
    signal?: AbortSignal,
    referer?: string,
    byteRange?: HlsByteRange,
    mediaHeaders?: Record<string, string>
  ): Promise<{ data: Buffer, url: string }> {
    let url = validateVideoSourceUrl(input)
    const safeReferer = referer ? validateVideoSourceUrl(referer).toString() : undefined
    const headers = normalizeMediaHeaders(mediaHeaders)
    const credentialHost = url.hostname
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) {
      throw new AppError('hls_invalid_limit', 'HLS 单资源大小限制无效', 400)
    }
    const safeRange = validateByteRange(byteRange, maxBytes)
    for (let hop = 0; hop <= 3; hop++) {
      if (signal?.aborted) throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
      const addresses = validatePinnedAddresses(await resolve(url))
      const routeList = await routes(url)
      let lastError: unknown
      let response: ResourceResponse | undefined
      for (const route of routeList) {
        for (const address of addresses) {
          if (signal?.aborted) throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
          try {
            const requestHeaders = { ...headers }
            if (url.hostname !== credentialHost) {
              delete requestHeaders.Cookie
              delete requestHeaders.Authorization
            }
            response = await request(url, address, route, maxBytes, signal, safeReferer, safeRange, requestHeaders)
            validateResourceResponse(response, maxBytes, safeRange)
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
}

export const readHlsResource = createHlsResourceReader()
