import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { isPublicIp } from '../downloader/directDownload.js'
import { AppError } from '../http.js'
import { parseCommentedJson } from './jsonCompat.js'
import { parseSourceProxyRoutes, preferIpv4, type SourceRoute } from './proxyRoute.js'

/** Called once by packaged Electron. On a headless server the default is direct. */
let systemProxyResolver: ((url: string) => Promise<string>) | undefined
export function configureVideoSourceProxyResolver(resolver?: (url: string) => Promise<string>) {
  systemProxyResolver = resolver
}

export function validateVideoSourceUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || !value.trim()) {
    throw new AppError('video_source_invalid_url', '请输入有效的影视源地址')
  }
  let url: URL
  try { url = new URL(value.trim()) }
  catch { throw new AppError('video_source_invalid_url', '影视源 URL 格式错误') }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !hostname || (!hostname.includes('.') && !isIP(hostname)) ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(hostname) ||
      (isIP(hostname) && !isPublicIp(hostname))) {
    throw new AppError('video_source_invalid_url', '只允许公开互联网 HTTP/HTTPS 影视源地址', 400)
  }
  if (url.port && Number(url.port) !== 80 && Number(url.port) !== 443) {
    throw new AppError('video_source_invalid_port', '影视源只允许 80/443 端口', 400)
  }
  url.hash = ''
  return url
}

interface ResponseData { text: string, location: string }

async function publicDns(url: URL): Promise<Array<{ address: string, family: number }>> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: Array<{ address: string, family: number }>
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true, verbatim: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code || 'DNS_FAILED'
    throw new AppError('video_source_dns_failed', '影视源域名解析失败（' + code + '）', 502)
  }
  if (!addresses.length || addresses.some(address => !isPublicIp(address.address))) {
    throw new AppError('video_source_private_address', '影视源域名解析到内网或保留 IP，已阻止', 403)
  }
  // Windows may resolve IPv6 first while the active network only supports IPv4.
  // Retain the original validated address set, try IPv4 first and retry alternate addresses.
  return preferIpv4(addresses).slice(0, 8)
}

export async function routesFor(url: URL): Promise<SourceRoute[]> {
  if (!systemProxyResolver) return [{ kind: 'direct' }]
  try {
    return parseSourceProxyRoutes(await systemProxyResolver(url.toString()))
  } catch {
    throw new AppError('video_source_proxy_unsupported', '系统代理无法识别或使用了暂不支持的代理协议（仅支持本机 HTTP 代理及直连）', 502)
  }
}

export async function tunnel(proxy: Extract<SourceRoute, { kind: 'proxy' }>, address: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const endpoint = address.includes(':') ? '[' + address + ']:' + port : address + ':' + port
    const req = httpRequest({
      host: proxy.host, port: proxy.port, method: 'CONNECT', path: endpoint,
      agent: false, timeout: 9000, headers: { Host: endpoint }
    })
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(Object.assign(new Error('Proxy refused HTTP CONNECT: ' + res.statusCode), { code: 'PROXY_CONNECT_' + res.statusCode }))
        return
      }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('Proxy timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })
}

async function requestPinned(
  url: URL, pin: { address: string, family: number }, route: SourceRoute
): Promise<ResponseData> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const targetPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  const proxySocket = route.kind === 'proxy' ? await tunnel(route, pin.address, targetPort) : undefined

  return new Promise((resolve, reject) => {
    let settled = false
    const done = (data: ResponseData) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      resolve(data)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      proxySocket?.destroy()
      reject(error)
    }
    const watchdog = setTimeout(() => {
      req.destroy(Object.assign(new Error('Source timeout'), { code: 'ETIMEDOUT' }))
    }, 13000)
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = transport(url, {
      agent: false,
      ...({ autoSelectFamily: false } as Record<string, unknown>),
      lookup: (_hostname: string, options: { all?: boolean }, callback: any) => {
        if (options?.all) callback(null, [{ address: pin.address, family: pin.family }])
        else callback(null, pin.address, pin.family)
      },
      ...(proxySocket ? {
        createConnection: () => url.protocol === 'https:'
          ? connectTls({ socket: proxySocket, servername: host, rejectUnauthorized: true })
          : proxySocket
      } : {}),
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; NetPanDownload/1.0)',
        'Accept-Encoding': 'identity'
      },
      timeout: 10000,
      maxHeaderSize: 16384
    }, res => {
      const status = res.statusCode || 0
      const location = Array.isArray(res.headers.location) ? '' : String(res.headers.location || '')
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume()
        if (!location) { fail(new AppError('video_source_redirect', '影视源跳转缺少 Location', 502)); return }
        done({ text: '', location })
        return
      }
      if (status < 200 || status > 299) {
        res.resume()
        fail(new AppError('video_source_http_error', '影视源返回 HTTP ' + status, 502))
        return
      }
      if (/text\/html/i.test(String(res.headers['content-type'] || ''))) {
        res.resume()
        fail(new AppError('video_source_bad_response', '源地址返回导航/网页 HTML，不是 TVBox JSON（可能需要在导航页复制真正配置地址）', 422))
        return
      }
      if (Number(res.headers['content-length'] || 0) > 1_500_000) {
        res.resume()
        fail(new AppError('video_source_too_large', '源配置超过 1.5MB 上限', 413))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1_500_000) {
          res.destroy(new AppError('video_source_too_large', '源配置超过 1.5MB 上限', 413))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => done({ text: Buffer.concat(chunks).toString('utf8'), location: '' }))
      res.on('error', fail)
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('Source timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', fail)
    req.end()
  })
}

function safeCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code || 'NETWORK_ERROR'
  return /^[A-Z0-9_]{2,45}$/i.test(code) ? code : 'NETWORK_ERROR'
}

export async function fetchVideoSourceJson(initial: string): Promise<unknown> {
  let url = validateVideoSourceUrl(initial)
  for (let hop = 0; hop <= 2; hop++) {
    const addresses = await publicDns(url)
    const routes = await routesFor(url)
    let last: unknown
    let response: ResponseData | undefined
    for (const route of routes) {
      for (const address of addresses) {
        try {
          response = await requestPinned(url, address, route)
          break
        } catch (error) {
          if (error instanceof AppError) throw error
          last = error
        }
      }
      if (response) break
    }
    if (!response) {
      const mode = routes.some(route => route.kind === 'proxy') ? '系统代理' : '直连'
      throw new AppError('video_source_network_failed',
        '影视源' + mode + '失败（' + safeCode(last) + '）。已尝试可用的 IPv4/IPv6 地址；请检查系统代理、VPN、DNS 与网络连接。', 502)
    }
    if (response.location) {
      if (hop === 2) throw new AppError('video_source_redirect', '影视源跳转超过 2 次', 502)
      url = validateVideoSourceUrl(new URL(response.location, url).toString())
      continue
    }
    try { return parseCommentedJson(response.text) }
    catch { throw new AppError('video_source_bad_response', '影视源响应不是可识别的 TVBox JSON 配置', 422) }
  }
  throw new AppError('video_source_redirect', '影视源重定向失败', 502)
}
