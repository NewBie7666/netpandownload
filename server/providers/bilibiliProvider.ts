import type { DownloadResult, ShareResult } from '../../shared/types.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import { AppError } from '../http.js'
import {
  buildFallback,
  normalizeProviderError,
  providerError,
  providerOk
} from './providerResponse.js'
import { expandBilibiliShortUrl, fetchBilibiliInitialState, resolveBilibiliAccess } from './bilibili/access/index.js'
import { resolveMedia } from './bilibili/media/mediaResolver.js'
import {
  assertEpisodeConsistency,
  cacheTtlMs,
  isBilibiliUrl,
  normalizeBiliUrl,
  resolveShare,
  type StableResolvedShare
} from './bilibili/resolver/index.js'
import type { Provider } from './types.js'

const infoCache = new Map<string, StableResolvedShare & { createdAt: number }>()

function getCacheEntry(shareId: string) {
  const entry = infoCache.get(shareId)
  if (!entry || Date.now() - entry.createdAt > cacheTtlMs) {
    infoCache.delete(shareId)
    return undefined
  }
  return entry
}

function debugProvider(message: string, details: Record<string, unknown>) {
  if (process.env.PROVIDER_DEBUG === 'true') {
    console.info(`[provider:bilibili] ${message}`, details)
  }
}

async function resolveRealShare(inputUrl: string): Promise<ShareResult & { source: StableResolvedShare['source'] }> {
  const resolved = await resolveShare(inputUrl, {
    runYtDlpJson: resolveBilibiliAccess,
    fetchInitialStateJson: fetchBilibiliInitialState,
    expandShortUrl: expandBilibiliShortUrl
  })
  assertEpisodeConsistency(resolved)
  infoCache.set(resolved.cacheKey, { ...resolved, createdAt: Date.now() })
  debugProvider('resolve', {
    episodeCount: resolved.episodes.length,
    source: resolved.source,
    normalizedUrl: resolved.normalizedUrl
  })
  return {
    shareId: resolved.cacheKey,
    stoken: 'bilibili-stable',
    path: [],
    files: resolved.files,
    source: resolved.source
  }
}

async function buildDownloadResult(
  file: StableResolvedShare['files'][number],
  episode: StableResolvedShare['episodes'][number]
): Promise<DownloadResult> {
  if (!episode.url) {
    throw new AppError('media_resolution_failed', 'B站单集地址为空，无法解析媒体直链')
  }

  const media = await resolveMedia(episode.url, { episodeInfo: episode.downloadInfo })
  const result: DownloadResult = {
    fid: file.fid,
    name: file.name,
    downloadUrl: media.url,
    source: 'direct',
    expiresAt: media.expiresAt,
    cached: false
  }
  registerAllowedDownloadResult(result)
  return result
}

export const bilibiliProvider: Provider = {
  id: 'bilibili',
  name: 'Bilibili',
  capabilities: {
    list: true,
    download: true,
    login: false,
    streaming: false
  },
  match(input) {
    return isBilibiliUrl(input)
  },
  async resolveShare(input) {
    try {
      const result = await resolveRealShare(input.shareUrl)
      const { source, ...share } = result
      return providerOk('bilibili', share, 'real', undefined, {
        episodeCount: share.files.length,
        source,
        normalizedUrl: normalizeBiliUrl(input.shareUrl)
      })
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'resolve')
      return buildFallback(
        'bilibili',
        'single_video_mode',
        normalized.message,
        'bilibili_resolve_failed',
        {
          error: normalized.code,
          fallback: 'single_video_mode'
        }
      )
    }
  },
  async list(input) {
    const cached = getCacheEntry(input.shareId)
    if (!cached) {
      return buildFallback(
        'bilibili',
        'episode_cache_miss',
        'Bilibili episode cache is missing or expired',
        'episode_cache_miss'
      )
    }

    try {
      assertEpisodeConsistency(cached)
      debugProvider('list', { episodeCount: cached.episodes.length, source: 'cache' })
      return providerOk('bilibili', { files: cached.files }, 'cache', undefined, {
        episodeCount: cached.episodes.length,
        source: 'cache'
      })
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'list')
      return providerError('bilibili', normalized.code, normalized.message, normalized.recoverable, 'cache')
    }
  },
  async getDownload(input) {
    const cached = getCacheEntry(input.shareId)
    if (!cached) {
      return providerError(
        'bilibili',
        'episode_cache_miss',
        'Bilibili episode cache is missing or expired',
        true,
        'fallback',
        'episode_cache_miss'
      )
    }

    try {
      assertEpisodeConsistency(cached)
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'download')
      return providerError('bilibili', normalized.code, normalized.message, normalized.recoverable, 'cache')
    }

    const index = cached.files.findIndex((file) => file.fid === input.file?.fid)
    const episode = cached.episodes[index]
    if (!episode) {
      return providerError(
        'bilibili',
        'episode_cache_miss',
        'Bilibili cached episode was not found for this file id',
        true,
        'fallback',
        'missing_episode'
      )
    }

    try {
      debugProvider('download', {
        episodeCount: cached.episodes.length,
        source: 'cache',
        resolvedEpisodeId: episode.id,
        resolvedEpisodeUrl: episode.url
      })
      return providerOk(
        'bilibili',
        await buildDownloadResult(cached.files[index], episode),
        'real',
        undefined,
        {
          episodeCount: cached.episodes.length,
          source: 'media',
          resolvedEpisodeId: episode.id,
          resolvedEpisodeUrl: episode.url
        }
      )
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'download')
      return providerError(
        'bilibili',
        normalized.code,
        normalized.message,
        normalized.recoverable,
        'fallback',
        normalized.code
      )
    }
  }
}

