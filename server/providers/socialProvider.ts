import { AppError } from '../http.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import { normalizeProviderError, providerError, providerOk } from './providerResponse.js'
import { extractSocialPost } from './social/extractor.js'
import { extractSocialSource, isSocialInput } from './social/source.js'
import type { SocialPlatform, SocialPost } from './social/types.js'
import type { DownloadResult } from '../../shared/types.js'
import type { Provider } from './types.js'

export function createSocialProvider(platform: SocialPlatform, loader: (url: string) => Promise<SocialPost> = extractSocialPost, now: () => number = Date.now): Provider {
  const cache = new Map<string, { post: SocialPost; storedAt: number }>()
  function entry(id: string) {
    const item = cache.get(id)
    if (!item || now() - item.storedAt > 8 * 60 * 1000) {
      cache.delete(id)
      throw new AppError('social_session_expired', '作品解析记录已过期，请重新粘贴完整分享链接')
    }
    return item
  }
  return {
    id: platform,
    name: platform === 'douyin' ? '抖音' : '小红书',
    capabilities: { list: true, download: true, login: false, streaming: false },
    match: input => isSocialInput(input, platform),
    async resolveShare(input) {
      try {
        const source = extractSocialSource(input.shareUrl, platform)
        const post = await loader(source.url)
        if (post.platform !== platform || !post.media.length) throw new AppError('social_parse_failed', '作品解析结果无效')
        const id = `${platform}:${post.id}`
        cache.set(id, { post, storedAt: now() })
        if (cache.size > 100) cache.delete(cache.keys().next().value!)
        return providerOk(platform, { shareId: id, stoken: 'social-single-post', path: [], files: post.media.map(item => item.file) }, 'real')
      } catch (error) {
        const result = normalizeProviderError(platform, error, 'resolve')
        return providerError(platform, result.code, result.message, result.recoverable)
      }
    },
    async list(input) {
      try {
        if (input.dirFid) throw new AppError('social_invalid_url', '单个作品没有文件夹')
        return providerOk(platform, { files: entry(input.shareId).post.media.map(item => item.file) }, 'cache')
      } catch (error) {
        const result = normalizeProviderError(platform, error, 'list')
        return providerError(platform, result.code, result.message, result.recoverable)
      }
    },
    async getDownload(input) {
      try {
        const item = entry(input.shareId)
        if (!item.post.media.some(media => media.file.fid === input.file?.fid)) throw new AppError('download_url_missing', '所选媒体不属于该作品，请重新解析')
        if (now() - item.storedAt > 60000) {
          const fresh = await loader(item.post.sourceUrl)
          if (fresh.platform !== platform || fresh.id !== item.post.id) throw new AppError('social_parse_failed', '刷新后的作品不匹配，请重新解析')
          item.post = fresh
          item.storedAt = now()
        }
        const media = item.post.media.find(media => media.file.fid === input.file?.fid)
        if (!media) throw new AppError('download_url_missing', '作品媒体已变化，请重新解析并选择')
        const download: DownloadResult = {
          fid: media.file.fid, name: media.file.name, downloadUrl: media.url,
          source: 'direct', cached: false, expiresAt: new Date(now() + 60000).toISOString()
        }
        registerAllowedDownloadResult(download)
        return providerOk(platform, download, 'real')
      } catch (error) {
        const result = normalizeProviderError(platform, error, 'download')
        return providerError(platform, result.code, result.message, result.recoverable)
      }
    }
  }
}

export const douyinProvider = createSocialProvider('douyin')
export const xiaohongshuProvider = createSocialProvider('xiaohongshu')
