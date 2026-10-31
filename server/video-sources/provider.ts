import type { VideoItem, VideoSearchResult, VideoSource } from '../../shared/videoSources.js'
import { AppError } from '../http.js'
import { addDirectDownloadTask } from '../downloader/downloadService.js'
import { validateDirectDownloadInput } from '../downloader/directDownload.js'
import { fetchVideoSourceJson } from './network.js'
import { listVideoSources } from './store.js'
import { parseMacCmsResponse } from './parser.js'

function validateId(value: unknown, type: 'source' | 'video'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
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

  async download(input: unknown) {
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
    const video = await this.detail(request.sourceId, request.videoId)
    const episode = video.lines[lineIndex]?.episodes[episodeIndex]
    if (!episode) throw new AppError('video_episode_missing', '未找到指定剧集', 404)
    if (episode.kind === 'hls') {
      throw new AppError('video_hls_not_ready', '这是 HLS/m3u8 分片流，当前版本未实现安全合并；不会将 m3u8 当 MP4 下载', 422)
    }
    if (episode.kind !== 'mp4') {
      throw new AppError('video_media_unsupported', '此线路不是可确认的 MP4 直链（不支持第三方播放器脚本解析）', 422)
    }
    const name = (video.title + '-' + episode.label).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 130) || 'video'
    const fileName = name + '.mp4'
    const safe = await validateDirectDownloadInput({ url: episode.url, fileName })
    const task = await addDirectDownloadTask({ url: safe.url, fileName: safe.fileName })
    return { ...task, sourceId: request.sourceId, videoId: request.videoId, fileName }
  }
}

export const videoSourceProvider = new VideoSourceProvider()
