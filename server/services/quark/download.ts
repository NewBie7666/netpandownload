import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import { config } from '../../config.js'
import { AppError } from '../../http.js'
import { quarkApi, type QuarkDownloadData } from '../../adapters/quarkApi.js'
import { registerAllowedDownloadResult } from '../../downloader/downloadService.js'
import type { DownloadResult, QuarkFile } from '../../../shared/types.js'

interface CacheEntry {
  downloadUrl: string
  expiresAt: number
  createdAt: number
  source: 'direct' | 'saved'
}

interface DownloadTicket {
  token: string
  fid: string
  fileName: string
  downloadUrl: string
  expiresAt: number
  createdAt: number
  source: 'direct' | 'saved' | 'proxy'
  shareId: string
  stoken: string
  file: QuarkFile
  sessionId?: string
  cacheKey: string
}

const downloadCache = new Map<string, CacheEntry>()
const downloadTickets = new Map<string, DownloadTicket>()
const downloadTicketTtlMs = 10 * 60 * 1000
const trustedHostSuffixes = ['pds.quark.cn', 'uc.cn', 'quark.cn']
const defaultDownloadUa =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const desktopDownloadUa =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch'

function buildCacheKey(shareId: string, fid: string, sessionId?: string) {
  return `${shareId}:${fid}:${sessionId || 'anonymous'}`
}

function parseDownloadUrlExpires(downloadUrl: string) {
  try {
    const expires = Number(new URL(downloadUrl).searchParams.get('Expires') || '')
    if (Number.isFinite(expires) && expires > 0) {
      return expires * 1000
    }
  } catch {
    return 0
  }
  return 0
}

function resolveDownloadExpires(downloadUrl: string) {
  return parseDownloadUrlExpires(downloadUrl) || Date.now() + config.downloadCacheTtlSeconds * 1000
}

function buildTicketProxyUrl(token: string) {
  return `/api/quark/download-proxy?token=${encodeURIComponent(token)}`
}

function createTicket(
  shareId: string,
  stoken: string,
  file: QuarkFile,
  sessionId: string | undefined,
  cacheKey: string,
  data: CacheEntry
) {
  const now = Date.now()
  const token = crypto.randomUUID()
  const expiresAt = Math.min(data.expiresAt, now + downloadTicketTtlMs)
  const ticket: DownloadTicket = {
    token,
    fid: file.fid,
    fileName: file.name,
    downloadUrl: data.downloadUrl,
    expiresAt,
    createdAt: now,
    source: data.source,
    shareId,
    stoken,
    file,
    sessionId,
    cacheKey
  }
  downloadTickets.set(token, ticket)
  return ticket
}

function requireCredentials(sessionId?: string) {
  const sessionCookie = quarkApi.getSessionCookie(sessionId)
  const configuredCookie = config.quarkCookie
  const cookie = sessionCookie || configuredCookie
  if (!cookie) {
    throw new AppError('missing_credentials', '服务端未配置解析凭据', 400)
  }
  return {
    cookie,
    userAgent: config.quarkUa || defaultDownloadUa
  }
}

function isTrustedDownloadUrl(downloadUrl: string) {
  try {
    const url = new URL(downloadUrl)
    return trustedHostSuffixes.some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
    )
  } catch {
    return false
  }
}

function sanitizeHeaderValue(value: string | null) {
  return value ? value : undefined
}

function buildContentDisposition(fileName: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

function isUpstreamExpired(status: number, bodyText: string) {
  const lowered = bodyText.toLowerCase()
  return (
    status === 401 ||
    status === 403 ||
    lowered.includes('requestdeniedbycallback') ||
    lowered.includes('auth not found') ||
    lowered.includes('expired')
  )
}

function getProxyUserAgent(source: DownloadTicket['source']) {
  if (source === 'saved') {
    return desktopDownloadUa
  }
  return config.quarkUa || defaultDownloadUa
}

async function resolveDownloadData(
  shareId: string,
  stoken: string,
  file: QuarkFile,
  sessionId?: string,
  forceRefresh = false
) {
  if (!String(shareId || '').trim() || !String(stoken || '').trim()) {
    throw new AppError('missing_session', '缺少分享会话信息，请重新获取文件列表')
  }
  if (!file || !file.fid || file.isDir) {
    throw new AppError('invalid_file', '请选择一个文件获取下载链接')
  }

  const now = Date.now()
  const key = buildCacheKey(shareId, file.fid, sessionId)
  const cached = downloadCache.get(key)
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return { key, data: cached, cached: true }
  }

  let rawData: QuarkDownloadData
  try {
    rawData = await quarkApi.getDownloadUrl(shareId, stoken, file, sessionId)
  } catch (error) {
    if (error instanceof AppError) {
      if (error.error === 'missing_share_file_token') {
        throw new AppError('missing_share_fid_token', '请重新获取文件列表后再获取下载链接')
      }
      if (
        error.error === 'quark_download_limited' ||
        error.error === 'quark_save_task_missing' ||
        error.error === 'quark_save_task_timeout' ||
        error.error === 'quark_saved_file_missing'
      ) {
        throw new AppError(
          'download_restricted',
          '该文件被夸克限制直链下载。普通小文件可正常解析；此类文件可能需要更高登录态、转存后下载，或被风控限制。'
        )
      }
      if (
        error.error === 'quark_unexpected_response' ||
        error.error === 'empty_download_url'
      ) {
        throw new AppError(
          'empty_download_url',
          '夸克未返回下载链接，可能是文件受限或接口变更'
        )
      }
      if (
        error.error === 'quark_network_error' ||
        error.error === 'quark_timeout'
      ) {
        throw new AppError('network_error', '夸克接口请求失败，请稍后重试', 502)
      }
    }
    throw error
  }

  if (!rawData.downloadUrl) {
    throw new AppError('empty_download_url', '夸克未返回下载链接，可能是文件受限或接口变更', 502)
  }

  const expiresAt = rawData.expiresAt ? Date.parse(rawData.expiresAt) : resolveDownloadExpires(rawData.downloadUrl)
  const entry: CacheEntry = {
    downloadUrl: rawData.downloadUrl,
    expiresAt,
    createdAt: now,
    source: rawData.source
  }
  downloadCache.set(key, entry)
  return { key, data: entry, cached: false }
}

async function refreshTicketDownloadUrl(ticket: DownloadTicket) {
  const refreshed = await resolveDownloadData(
    ticket.shareId,
    ticket.stoken,
    ticket.file,
    ticket.sessionId,
    true
  )
  ticket.downloadUrl = refreshed.data.downloadUrl
  ticket.expiresAt = Math.min(refreshed.data.expiresAt, Date.now() + downloadTicketTtlMs)
  ticket.source = refreshed.data.source
  ticket.createdAt = Date.now()
  downloadTickets.set(ticket.token, ticket)
  return ticket
}

function requireDownloadTicket(token: string | undefined) {
  const value = String(token || '').trim()
  if (!value) {
    throw new AppError('invalid_download_token', '下载票据无效或已过期，请重新点击转链', 401)
  }
  const ticket = downloadTickets.get(value)
  if (!ticket) {
    throw new AppError('invalid_download_token', '下载票据无效或已过期，请重新点击转链', 401)
  }
  if (ticket.expiresAt <= Date.now()) {
    downloadTickets.delete(value)
    throw new AppError('download_token_expired', '下载票据无效或已过期，请重新点击转链', 410)
  }
  return ticket
}

export async function getQuarkDownloadUrl(
  shareId: string,
  stoken: string,
  file: QuarkFile,
  sessionId?: string
): Promise<DownloadResult> {
  const { key, data, cached } = await resolveDownloadData(shareId, stoken, file, sessionId)

  if (data.source === 'direct') {
    const result: DownloadResult = {
      fid: file.fid,
      name: file.name,
      downloadUrl: data.downloadUrl,
      source: 'direct',
      expiresAt: new Date(data.expiresAt).toISOString(),
      cached
    }
    registerAllowedDownloadResult(result)
    return result
  }

  requireCredentials(sessionId)
  const ticket = createTicket(shareId, stoken, file, sessionId, key, data)
  const result: DownloadResult = {
    fid: file.fid,
    name: file.name,
    downloadToken: ticket.token,
    proxyUrl: buildTicketProxyUrl(ticket.token),
    source: 'proxy',
    expiresAt: new Date(ticket.expiresAt).toISOString(),
    cached
  }
  registerAllowedDownloadResult(result)
  return result
}

export async function proxyQuarkDownload(req: Request, res: Response) {
  const ticket = requireDownloadTicket(typeof req.query.token === 'string' ? req.query.token : undefined)
  const credentials = requireCredentials(ticket.sessionId)

  let activeTicket = ticket
  if (activeTicket.expiresAt <= Date.now() || parseDownloadUrlExpires(activeTicket.downloadUrl) <= Date.now()) {
    try {
      activeTicket = await refreshTicketDownloadUrl(activeTicket)
    } catch {
      throw new AppError('download_url_expired', '下载链接已过期，请重新点击转链。', 410)
    }
  }

  if (!isTrustedDownloadUrl(activeTicket.downloadUrl)) {
    throw new AppError('untrusted_download_host', '下载地址不受信任，已拒绝代理请求', 403)
  }

  const upstreamUrl = new URL(activeTicket.downloadUrl)
  const requestHeaders = new Headers()
  requestHeaders.set('User-Agent', getProxyUserAgent(activeTicket.source))
  requestHeaders.set('Cookie', credentials.cookie)
  requestHeaders.set('Referer', 'https://pan.quark.cn/')
  requestHeaders.set('Origin', 'https://pan.quark.cn')
  requestHeaders.set('Accept', '*/*')
  requestHeaders.set('Accept-Language', 'zh-CN,zh;q=0.9')
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : ''
  if (rangeHeader) {
    requestHeaders.set('Range', rangeHeader)
  }

  console.log(
    `[download-proxy] host=${upstreamUrl.host} fid=${activeTicket.fid} fileName=${activeTicket.fileName} source=${activeTicket.source}`
  )

  let upstream = await fetch(upstreamUrl, {
    method: 'GET',
    headers: requestHeaders,
    redirect: 'follow'
  })

  let upstreamErrorBody = ''
  if (!upstream.ok) {
    upstreamErrorBody = await upstream.text()
    console.log(
      `[download-proxy] upstream-status=${upstream.status} host=${upstreamUrl.host} fid=${activeTicket.fid} source=${activeTicket.source} body=${upstreamErrorBody.slice(0, 220).replace(/\s+/g, ' ')}`
    )
  }

  if (!upstream.ok && isUpstreamExpired(upstream.status, upstreamErrorBody)) {
    try {
      activeTicket = await refreshTicketDownloadUrl(activeTicket)
    } catch {
      throw new AppError('download_url_expired', '下载链接已过期，请重新点击转链。', 410)
    }

    const retryUrl = new URL(activeTicket.downloadUrl)
    if (!isTrustedDownloadUrl(activeTicket.downloadUrl)) {
      throw new AppError('untrusted_download_host', '下载地址不受信任，已拒绝代理请求', 403)
    }

    upstream = await fetch(retryUrl, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'follow'
    })
    if (!upstream.ok) {
      upstreamErrorBody = await upstream.text()
      console.log(
        `[download-proxy] retry-upstream-status=${upstream.status} host=${retryUrl.host} fid=${activeTicket.fid} source=${activeTicket.source} body=${upstreamErrorBody.slice(0, 220).replace(/\s+/g, ' ')}`
      )
    }
  }

  if (!upstream.ok || !upstream.body) {
    throw new AppError('download_proxy_failed', '代理下载失败，当前登录态可能仍不足或文件已受限', 502)
  }

  const statusCode = upstream.status === 206 ? 206 : 200
  res.status(statusCode)

  const acceptRanges = sanitizeHeaderValue(upstream.headers.get('accept-ranges')) || 'bytes'
  const contentRange = sanitizeHeaderValue(upstream.headers.get('content-range'))
  const contentLength = sanitizeHeaderValue(upstream.headers.get('content-length'))
  const contentType =
    sanitizeHeaderValue(upstream.headers.get('content-type')) || 'application/octet-stream'
  const contentDisposition =
    sanitizeHeaderValue(upstream.headers.get('content-disposition')) ||
    buildContentDisposition(activeTicket.fileName)

  res.setHeader('Accept-Ranges', acceptRanges)
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', contentDisposition)
  if (contentRange) {
    res.setHeader('Content-Range', contentRange)
  }
  if (contentLength) {
    res.setHeader('Content-Length', contentLength)
  }

  const bodyStream = Readable.fromWeb(upstream.body as any)
  await pipeline(bodyStream, res)
}

export function getDownloadCacheStats() {
  return {
    size: downloadCache.size,
    tickets: downloadTickets.size
  }
}
