import type { Provider } from './types.js'
import type { DownloadResult } from '../../shared/types.js'
import { providerError, providerOk, normalizeProviderError } from './providerResponse.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import { extractYoutubeVideo, isYoutubeVideoUrl, normalizeYoutubeUrl, type YoutubeVideo } from './youtube/youtubeParser.js'

const cache = new Map<string, { video: YoutubeVideo, created: number }>()
const CACHE_TTL = 90000
async function load(id: string) {
  const match = /^youtube:([A-Za-z0-9_-]{11})$/.exec(id)
  if (!match) throw new Error('无效的 YouTube 任务')
  const cached = cache.get(id)
  if (cached && Date.now() - cached.created < CACHE_TTL) return cached.video
  const video = await extractYoutubeVideo(`https://www.youtube.com/watch?v=${match[1]}`)
  cache.set(id, { video, created: Date.now() })
  if (cache.size > 100) cache.clear()
  return video
}

export const youtubeProvider: Provider = {
  id: 'youtube',
  name: 'YouTube',
  capabilities: { list: true, download: true, login: false, streaming: false },
  match: isYoutubeVideoUrl,
  async resolveShare(input) {
    try {
      const normalized = normalizeYoutubeUrl(input.shareUrl)
      const video = await load(normalized.shareId)
      return providerOk('youtube', {
        shareId: normalized.shareId, stoken: 'youtube-single-video',
        path: [], files: [video.file]
      }, 'real')
    } catch (error) {
      const e = normalizeProviderError('youtube', error, 'resolve')
      return providerError('youtube', e.code, e.message, e.recoverable)
    }
  },
  async list(input) {
    try {
      if (input.dirFid) throw new Error('YouTube 视频没有文件夹')
      const video = await load(input.shareId)
      return providerOk('youtube', { files: [video.file] }, 'cache')
    } catch (error) {
      const e = normalizeProviderError('youtube', error, 'list')
      return providerError('youtube', e.code, e.message, e.recoverable)
    }
  },
  async getDownload(input) {
    try {
      const video = await load(input.shareId)
      if (video.file.fid !== input.file?.fid)
        return providerError('youtube', 'download_url_missing', '视频 ID 不匹配，请重新解析', false)
      const download: DownloadResult = {
        fid: video.file.fid,
        name: video.file.name,
        downloadUrl: video.mediaUrl,
        source: 'direct',
        cached: false,
        expiresAt: new Date(Date.now() + 90000).toISOString()
      }
      registerAllowedDownloadResult(download)
      return providerOk('youtube', download, 'real')
    } catch (error) {
      const e = normalizeProviderError('youtube', error, 'download')
      return providerError('youtube', e.code, e.message, e.recoverable)
    }
  }
}
