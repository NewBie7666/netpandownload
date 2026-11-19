import { request } from 'node:http'
import { isIP } from 'node:net'
import type { VideoSource } from '../../shared/videoSources.js'
import { AppError } from '../http.js'
import type { Type3Action, Type3Arguments } from './type3.js'

/**
 * MTplayer Android-fish2018 SpiderGateway wire protocol. Only loopback is
 * trusted: use `adb forward tcp:18777 tcp:9978` when Android runs on a phone.
 * Never forward the Bearer token to an imported, remote source URL.
 */
export type Type3GatewayMode = 'off' | 'native' | 'always'
interface GatewaySettings { url: URL; token: string; mode: Exclude<Type3GatewayMode, 'off'> }
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 90_000

export function type3GatewayMode(): Type3GatewayMode {
  const configured = String(process.env.NETPAN_TYPE3_GATEWAY_MODE || '').trim().toLowerCase()
  if (configured === 'off') return 'off'
  if (configured === 'native' || configured === 'always') return configured
  return process.env.NETPAN_TYPE3_GATEWAY_URL ? 'native' : 'off'
}

function settings(): GatewaySettings {
  const input = String(process.env.NETPAN_TYPE3_GATEWAY_URL || '').trim()
  const token = String(process.env.NETPAN_TYPE3_GATEWAY_TOKEN || '').trim()
  let url: URL
  try { url = new URL(input) }
  catch { throw new AppError('type3_gateway_config_invalid', 'Android Gateway 地址格式错误，请使用 http://127.0.0.1:18777', 422) }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new AppError('type3_gateway_config_invalid',
      'Android Gateway 仅允许通过 ADB 转发连接本机 HTTP 回环地址，不允许直接传令牌到局域网或公网', 422)
  }
  if (token.length < 16 || token.length > 256 || /[\r\n\u0000-\u001f\u007f]/.test(token) || token === 'mtplayer-local') {
    throw new AppError('type3_gateway_config_invalid',
      '请配置 Android Gateway 的独立随机令牌（至少 16 字符），不能使用默认共享令牌', 422)
  }
  const mode = type3GatewayMode()
  if (mode === 'off') throw new AppError('type3_gateway_disabled', 'Android Gateway 未启用', 422)
  return { url, token, mode }
}

export function shouldUseType3Gateway(action: Type3Action, source: VideoSource, localError?: unknown): boolean {
  if (source.type !== 'type3' || source.runtime === 'javascript' || !/^csp_[A-Za-z0-9_.$]+$/.test(source.apiUrl)) return false
  if (type3GatewayMode() === 'always') return true
  return type3GatewayMode() === 'native' && localError instanceof AppError &&
    localError.error === 'type3_java_native_unsupported'
}

function requestPayload(source: VideoSource, action: Type3Action, args: Type3Arguments): { method: string; body: Record<string, unknown> } {
  if (!source.spider || !/^https?:\/\//i.test(source.spider)) {
    throw new AppError('type3_gateway_spider_missing', 'Android Gateway 需要原始 TVBox Spider JAR 地址', 422)
  }
  const site = {
    key: source.key || source.apiUrl,
    name: source.name,
    api: source.apiUrl,
    type: 3,
    jar: source.spider,
    ext: typeof source.ext === 'string' ? source.ext : JSON.stringify(source.ext ?? ''),
    searchable: 1
  }
  const body: Record<string, unknown> = { site }
  if (action === 'search') { body.keyword = args.keyword || ''; body.page = String(args.page || 1); body.quick = false }
  if (action === 'detail') body.id = args.id || ''
  if (action === 'play') { body.id = args.id || ''; body.flag = args.flag || '' }
  return { method: action === 'play' ? 'player' : action, body }
}

function gatewayRequest(url: URL, token: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body)
  if (Buffer.byteLength(payload) > 512 * 1024) {
    throw new AppError('type3_gateway_request_large', 'Android Gateway 请求超过 512KB', 413)
  }
  return new Promise((resolve, reject) => {
    const endpoint = new URL('/v1/spider/' + method, url)
    const chunks: Buffer[] = []
    let received = 0
    let settled = false
    const fail = (error: AppError) => { if (!settled) { settled = true; reject(error) } }
    const req = request(endpoint, {
      method: 'POST',
      agent: false,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'close'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, res => {
      if (Number(res.headers['content-length'] || 0) > MAX_RESPONSE_BYTES) {
        fail(new AppError('type3_gateway_response_large', 'Android Gateway 响应超过 2MB', 502))
        res.destroy()
        return
      }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_RESPONSE_BYTES) {
          fail(new AppError('type3_gateway_response_large', 'Android Gateway 响应超过 2MB', 502))
          res.destroy()
        } else chunks.push(chunk)
      })
      res.on('end', () => {
        if (settled) return
        let parsed: unknown
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { fail(new AppError('type3_gateway_bad_response', 'Android Gateway 返回的不是有效 JSON', 502)); return }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(new AppError('type3_gateway_bad_response', 'Android Gateway 响应缺少 JSON 对象', 502)); return
        }
        const result = parsed as Record<string, unknown>
        if (res.statusCode !== 200 || result.ok === false) {
          const message = res.statusCode === 401 ? 'Android Gateway 令牌无效'
            : String(result.message || 'Android Spider 运行失败').slice(0, 350).replaceAll(token, '[redacted]')
          fail(new AppError('type3_gateway_execution_failed', message, 502))
          return
        }
        settled = true
        resolve(result)
      })
      res.on('error', () => fail(new AppError('type3_gateway_network_failed', 'Android Gateway 读取响应中断', 502)))
    })
    req.on('timeout', () => req.destroy(new Error('gateway-timeout')))
    req.on('error', () => fail(new AppError('type3_gateway_unavailable',
      '无法连接 Android Spider Gateway，检查手机服务、ADB 端口转发与令牌配置', 503)))
    req.end(payload)
  })
}

function assertNotDeviceLocalMedia(result: Record<string, unknown>): void {
  const value = result.url
  if (typeof value !== 'string' || !value.trim()) return
  if (value.startsWith('/v1/spider/native/')) {
    throw new AppError('type3_gateway_media_proxy_required',
      'Android 返回了设备本机媒体代理路径；Windows 下载器尚未实现安全的网关媒体转发，不能直接下载', 422)
  }
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.local') || (isIP(host) && (
      host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1'))) {
      throw new AppError('type3_gateway_media_proxy_required',
        'Android 返回了局域网/设备本机媒体地址；该线路需要安全媒体代理，不能绕开下载器的内网地址保护', 422)
    }
  } catch (error) {
    if (error instanceof AppError) throw error
  }
}

export async function invokeType3Gateway(
  source: VideoSource, action: Type3Action, args: Type3Arguments = {}
): Promise<Record<string, unknown>> {
  if (!shouldUseType3Gateway(action, source, new AppError('type3_java_native_unsupported', 'native'))) {
    throw new AppError('type3_gateway_unsupported', '该站点不是 Android csp_* Spider', 422)
  }
  const { url, token } = settings()
  const { method, body } = requestPayload(source, action, args)
  const result = await gatewayRequest(url, token, method, body)
  if (action === 'play') assertNotDeviceLocalMedia(result)
  return result
}
