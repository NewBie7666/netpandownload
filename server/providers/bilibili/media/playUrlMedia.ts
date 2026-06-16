import { AppError } from '../../../http.js'
import { createAccessContext, type AccessContext } from '../access/context.js'
import { buildBilibiliHeaders } from '../access/headers.js'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pickBvid(episodeUrl: string, episodeInfo: unknown) {
  const info = isRecord(episodeInfo) ? episodeInfo : undefined
  const arc = info && isRecord(info.arc) ? info.arc : undefined
  const urlMatch = episodeUrl.match(/\/video\/(BV[0-9A-Za-z]+)/i)
  return asString(info?.bvid) || asString(arc?.bvid) || urlMatch?.[1] || ''
}

function pickCid(episodeInfo: unknown) {
  const info = isRecord(episodeInfo) ? episodeInfo : undefined
  const page = info && isRecord(info.page) ? info.page : undefined
  const pages = info && Array.isArray(info.pages) ? info.pages.filter(isRecord) : []
  return asNumber(info?.cid) || asNumber(page?.cid) || asNumber(pages[0]?.cid)
}

function pickPlayableUrl(payload: unknown) {
  if (!isRecord(payload)) return ''
  const data = isRecord(payload.data) ? payload.data : undefined
  const durl = data && Array.isArray(data.durl) ? data.durl.filter(isRecord) : []
  return asString(durl[0]?.url)
}

export async function resolvePlayUrlMedia(
  episodeUrl: string,
  episodeInfo: unknown,
  accessContext?: AccessContext
) {
  const bvid = pickBvid(episodeUrl, episodeInfo)
  const cid = pickCid(episodeInfo)
  if (!bvid || !cid) {
    throw new AppError('media_resolution_failed', 'B站单集缺少 bvid 或 cid，无法解析媒体直链')
  }

  const context = accessContext || createAccessContext(episodeUrl)
  const apiUrl = new URL('https://api.bilibili.com/x/player/playurl')
  apiUrl.searchParams.set('bvid', bvid)
  apiUrl.searchParams.set('cid', String(cid))
  apiUrl.searchParams.set('qn', '64')
  apiUrl.searchParams.set('fnval', '0')
  apiUrl.searchParams.set('fourk', '1')

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: buildBilibiliHeaders(context),
    signal: AbortSignal.timeout(12000)
  })
  if (response.status === 412) {
    throw new AppError('media_resolution_failed', 'B站返回风控限制，无法解析媒体直链')
  }
  if (!response.ok) {
    throw new AppError('media_resolution_failed', `B站媒体接口请求失败：${response.status}`)
  }

  const payload = await response.json()
  const url = pickPlayableUrl(payload)
  if (!url) {
    throw new AppError('media_resolution_failed', 'B站媒体接口未返回可下载直链')
  }
  return url
}
