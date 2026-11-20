import type { VideoItem, VideoSearchResult, VideoSource } from '../../shared/videoSources.js'
import { AppError } from '../http.js'
import { addDirectDownloadTask } from '../downloader/downloadService.js'
import { validateDirectDownloadInput } from '../downloader/directDownload.js'
import { enqueueHls } from '../hls/hlsTasks.js'
import { fetchVideoSourceJson } from './network.js'
import { listVideoSources } from './store.js'
import { parseMacCmsResponse } from './parser.js'
import { invokeType3, resolveType3WebMedia } from './type3.js'
import { normalizeMediaHeaders } from './mediaHeaders.js'

function validateId(value: unknown, type: 'source' | 'video'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > (type === 'video' ? 4096 : 100) ||
      /[\u0000-\u001f\u007f]/.test(value) || (type === 'source' && !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new AppError('video_source_invalid_id', '资源或影视源 ID 不正确')
  }
  return value
}

function safePage(input: unknown): number {
  const value = Number(input === undefined ? 1 : input)
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new AppError('video_source_invalid_page', '分页超出范围')
  return value
}

/** Separate provider domain; no fake Quark ShareResult or direct provider registry mutation. */
export class VideoSourceProvider {
  private async source(sourceId: unknown): Promise<VideoSource> {
    const id = validateId(sourceId, 'source')
    const source = (await listVideoSources()).find(item => item.id === id)
    if (!source) throw new AppError('video_source_missing', '影视源不存在', 404)
    if (!source.enabled) throw new AppError('video_source_disabled', '影视源已停用', 409)
    return source
  }

  private async query(source: VideoSource, params: Record<string, string>) {
    if (source.type === 'type3') {
      const action = params.ids ? 'detail' : params.wd ? 'search' : 'home'
      const result = await invokeType3(source, action, { id: params.ids, keyword: params.wd, page: Number(params.pg || 1) })
      if (!Array.isArray(result.list) && (action !== 'home' || !Array.isArray(result.class))) {
        throw new AppError('type3_invalid_result', 'Type3 ' + action + ' 没有返回 list 数组，不能视为兼容成功', 502)
      }
      const parsed = parseMacCmsResponse({ ...result, list: result.list ?? [], page: result.page || params.pg })
      for (const item of parsed.items) for (const line of item.lines) for (const episode of line.episodes) episode.kind = 'resolve'
      return parsed
    }
    const url = new URL(source.apiUrl)
    url.searchParams.set('ac', 'detail')
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return parseMacCmsResponse(await fetchVideoSourceJson(url.toString()))
  }

  async test(sourceId: unknown) {
    const source = await this.source(sourceId)
    const result = await this.query(source, { pg: '1' })
    return { sourceId: source.id, ok: true, sampleCount: result.items.length }
  }

  async search(sourceId: unknown, word: unknown, pageValue: unknown = 1): Promise<VideoSearchResult> {
    const source = await this.source(sourceId)
    if (typeof word !== 'string' || !word.trim() || word.trim().length > 80) {
      throw new AppError('video_source_invalid_keyword', '搜索关键词必须为 1-80 个字符')
    }
    const page = safePage(pageValue)
    const result = await this.query(source, { wd: word.trim(), pg: String(page) })
    return { sourceId: source.id, keyword: word.trim(), ...result }
  }

  async detail(sourceId: unknown, videoId: unknown): Promise<VideoItem> {
    const source = await this.source(sourceId)
    const id = validateId(videoId, 'video')
    const result = await this.query(source, { ids: id })
    const item = result.items.find(item => item.id === id)
    if (!item) throw new AppError('video_not_found', '影视源没有返回所选影片详情', 404)
    return item
  }

  async resolve(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AppError('video_download_invalid', '下载参数不正确')
    }
    const request = input as Record<string, unknown>
    const lineIndex = Number(request.lineIndex)
    const episodeIndex = Number(request.episodeIndex)
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= 12 ||
        !Number.isInteger(episodeIndex) || episodeIndex < 0 || episodeIndex >= 250) {
      throw new AppError('video_download_invalid', '播放线路或剧集编号不正确')
    }
    // Re-resolve from the saved source; never accept media URLs or file paths from the browser.
    const source = await this.source(request.sourceId)
    const video = await this.detail(source.id, request.videoId)
    const episode = video.lines[lineIndex]?.episodes[episodeIndex]
    if (!episode) throw new AppError('video_episode_missing', '未找到指定剧集', 404)
    let url = episode.url
    let kind = episode.kind
    let detectedKind: 'hls' | 'mp4' | undefined
    let headers: Record<string, string> = {}
    if (source.type === 'type3') {
      const result = await invokeType3(source, 'play', { flag: video.lines[lineIndex].name, id: episode.url })
      if (typeof result.url !== 'string' || !result.url.trim()) throw new AppError('type3_media_missing', 'Type3 播放解析未返回媒体地址', 502)
      url = String(result.playUrl || '') + result.url
      headers = normalizeMediaHeaders(result.header || result.headers)
      if (result.parse === 1 || result.parse === '1' || result.jx === 1 || result.jx === '1') {
        await validateDirectDownloadInput({ url })
        const media = await resolveType3WebMedia(url, headers)
        url = media.url
        headers = normalizeMediaHeaders(media.headers)
        detectedKind = media.kind
      }
      const format = String(result.format || result.type || '')
      kind = detectedKind || (/\.m3u8(?:[?#]|$)/i.test(url) || /m3u8|mpegurl/i.test(format) ? 'hls' : 'mp4')
    }
    if (!['hls', 'mp4'].includes(kind)) throw new AppError('video_media_unsupported', '该剧集需要尚未接入的解析器', 422)
    const safe = await validateDirectDownloadInput({ url })
    const name = (video.title + '-' + episode.label).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 130) || 'video'
    const fileName = name + '.mp4'
    return { sourceId: source.id, videoId: video.id, url: safe.url, headers, kind, fileName }
  }

  async download(input: unknown) {
    const resolved = await this.resolve(input)
    const { url, fileName, headers } = resolved
    const task = resolved.kind === 'hls'
      ? await enqueueHls({ url, fileName }, { allowExtensionless: true, headers })
      : await addDirectDownloadTask({ url, fileName }, headers)
    const { sourceId, videoId } = resolved
    return { ...task, sourceId, videoId, fileName }
  }
}

export const videoSourceProvider = new VideoSourceProvider()
