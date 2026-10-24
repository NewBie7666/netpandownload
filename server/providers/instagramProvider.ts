import type { Provider } from './types.js'
import { providerError, providerOk, normalizeProviderError } from './providerResponse.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import { extractInstagramPost, normalizeInstagramPost, isInstagramPostUrl, type InstagramPost } from './instagram/galleryParser.js'
import type { DownloadResult } from '../../shared/types.js'

const cache = new Map<string, { post: InstagramPost; storedAt: number }>()
const TTL = 8 * 60 * 1000
const SIGNED_URL_TTL = 5 * 60 * 1000

async function getPost(id: string) {
  const match = /^instagram:(p|reel|tv):([A-Za-z0-9_-]+)$/.exec(id)
  if (!match) throw new Error('无效的 Instagram 帖子 ID')
  const cached = cache.get(id)
  if (cached && Date.now() - cached.storedAt < TTL) return cached.post
  const post = await extractInstagramPost(`https://www.instagram.com/${match[1]}/${match[2]}/`)
  cache.set(id, { post, storedAt: Date.now() })
  if (cache.size > 100) {
    for (const [key, item] of cache) {
      if (Date.now() - item.storedAt >= TTL) cache.delete(key)
    }
    if (cache.size > 100) cache.delete(cache.keys().next().value!)
  }
  return post
}

export const instagramProvider: Provider = {
  id: 'instagram',
  name: 'Instagram',
  capabilities: { list: true, download: true, login: false, streaming: false },
  match: isInstagramPostUrl,
  async resolveShare(input) {
    try {
      const normalized = normalizeInstagramPost(input.shareUrl)
      const post = await getPost(normalized.shareId)
      return providerOk('instagram', {
        shareId: post.shareId,
        stoken: 'instagram-single-post',
        path: [],
        files: post.media.map((entry) => entry.file)
      }, 'real')
    } catch (error) {
      const result = normalizeProviderError('instagram', error, 'resolve')
      return providerError('instagram', result.code, result.message, result.recoverable)
    }
  },
  async list(input) {
    try {
      if (input.dirFid) throw new Error('Instagram 单个帖子没有文件夹')
      const post = await getPost(input.shareId)
      return providerOk('instagram', { files: post.media.map((entry) => entry.file) }, 'cache')
    } catch (error) {
      const result = normalizeProviderError('instagram', error, 'list')
      return providerError('instagram', result.code, result.message, result.recoverable)
    }
  },
  async getDownload(input) {
    try {
      const post = await getPost(input.shareId)
      // Never trust a client-supplied media URL or file metadata.
      const match = post.media.find((media) => media.fid === input.file?.fid)
      if (!match) {
        return providerError('instagram', 'download_url_missing', '所选媒体不属于此 Instagram 帖子，请重新解析', false)
      }
      const download: DownloadResult = {
        fid: match.file.fid,
        name: match.file.name,
        downloadUrl: match.url,
        source: 'direct',
        expiresAt: new Date(Date.now() + SIGNED_URL_TTL).toISOString(),
        cached: false
      }
      registerAllowedDownloadResult(download)
      return providerOk('instagram', download, 'real')
    } catch (error) {
      const result = normalizeProviderError('instagram', error, 'download')
      return providerError('instagram', result.code, result.message, result.recoverable)
    }
  }
}
