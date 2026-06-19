import type { DownloadResult, ShareResult } from '../../shared/types.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import { AppError } from '../http.js'
import { structuredLogger } from '../logging/structuredLogger.js'
import { assertBilibiliRuntimeFreeze } from '../release/freezeGuard.js'
import {
  buildFallback,
  normalizeProviderError,
  providerError,
  providerOk
} from './providerResponse.js'
import { expandBilibiliShortUrl, fetchBilibiliInitialState, resolveBilibiliAccess } from './bilibili/access/index.js'
import { getCachedCookieHealth } from './bilibili/authContext/index.js'
import { calculateDownloadHealth, diagnoseBilibiliFailure } from './bilibili/diagnostics/index.js'
import { resolveMedia } from './bilibili/media/mediaResolver.js'
import {
  createTraceContext,
  createTraceEvent,
  getTrace,
  recordTraceEvent,
  startTrace,
  traceStage,
  type BilibiliTraceContext
} from './bilibili/observability/index.js'
import {
  assertEpisodeConsistency,
  cacheTtlMs,
  isBilibiliUrl,
  normalizeBiliUrl,
  resolveShare,
  type StableResolvedShare
} from './bilibili/resolver/index.js'
import { getFailureInsight } from './bilibili/stability/index.js'
import type { Provider } from './types.js'

assertBilibiliRuntimeFreeze()

const infoCache = new Map<string, StableResolvedShare & { createdAt: number }>()
const stableShareIdPrefix = 'bili:stable:'

function getCacheEntry(shareId: string) {
  const entry = infoCache.get(shareId)
  if (!entry || Date.now() - entry.createdAt > cacheTtlMs) {
    infoCache.delete(shareId)
    return undefined
  }
  return entry
}

function getUrlFromStableShareId(shareId: string) {
  if (!shareId.startsWith(stableShareIdPrefix)) {
    return ''
  }
  return shareId.slice(stableShareIdPrefix.length)
}

function debugProvider(message: string, details: Record<string, unknown>) {
  if (process.env.PROVIDER_DEBUG === 'true') {
    structuredLogger.debug('provider:bilibili', message, details, typeof details.traceId === 'string' ? details.traceId : undefined)
  }
}

async function resolveStableShare(
  inputUrl: string,
  traceContext: BilibiliTraceContext
): Promise<StableResolvedShare & { createdAt: number }> {
  const resolved = await traceStage(
    traceContext,
    'resolver',
    () => resolveShare(inputUrl, {
      runYtDlpJson: (url) => resolveBilibiliAccess(url, traceContext),
      fetchInitialStateJson: (url) => fetchBilibiliInitialState(url, traceContext),
      expandShortUrl: (url) => expandBilibiliShortUrl(url, traceContext)
    }),
    recordTraceEvent
  )
  assertEpisodeConsistency(resolved)
  const cached = { ...resolved, createdAt: Date.now() }
  infoCache.set(resolved.cacheKey, cached)
  debugProvider('resolve', {
    episodeCount: resolved.episodes.length,
    source: resolved.source,
    normalizedUrl: resolved.normalizedUrl,
    traceId: traceContext.traceId
  })
  return cached
}

async function getOrRefreshCacheEntry(shareId: string, traceContext: BilibiliTraceContext) {
  const cached = getCacheEntry(shareId)
  if (cached) {
    return cached
  }

  const sourceUrl = getUrlFromStableShareId(shareId)
  if (!sourceUrl || !isBilibiliUrl(sourceUrl)) {
    return undefined
  }

  debugProvider('cache_refresh', {
    shareId,
    sourceUrl,
    traceId: traceContext.traceId
  })

  try {
    const refreshed = await resolveStableShare(sourceUrl, traceContext)
    return refreshed.cacheKey === shareId ? refreshed : getCacheEntry(shareId)
  } catch (error) {
    debugProvider('cache_refresh_failed', {
      shareId,
      traceId: traceContext.traceId,
      error: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}

async function resolveRealShare(
  inputUrl: string,
  traceContext: BilibiliTraceContext
): Promise<ShareResult & { source: StableResolvedShare['source'] }> {
  const resolved = await resolveStableShare(inputUrl, traceContext)
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
  episode: StableResolvedShare['episodes'][number],
  traceContext: BilibiliTraceContext
): Promise<DownloadResult> {
  if (!episode.url) {
    throw new AppError('media_resolution_failed', 'B站单集地址为空，无法解析媒体直链')
  }

  const media = await resolveMedia(episode.url, { episodeInfo: episode.downloadInfo, traceContext })
  const result: DownloadResult = {
    fid: file.fid,
    name: file.name,
    downloadUrl: media.url,
    source: 'direct',
    expiresAt: media.expiresAt,
    cached: false
  }
  registerAllowedDownloadResult(result)
  recordTraceEvent(traceContext, createTraceEvent('handoff', 'success'))
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
    const traceContext = createTraceContext(input.shareUrl, 'resolve')
    startTrace(traceContext)
    try {
      const result = await resolveRealShare(input.shareUrl, traceContext)
      const { source, ...share } = result
      return providerOk('bilibili', share, 'real', undefined, {
        episodeCount: share.files.length,
        source,
        normalizedUrl: normalizeBiliUrl(input.shareUrl),
        traceId: traceContext.traceId,
        health: calculateDownloadHealth()
      })
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'resolve')
      const insight = getFailureInsight(error, 'resolve')
      const diagnosis = diagnoseBilibiliFailure([insight], getTrace(traceContext.traceId), getCachedCookieHealth())
      return buildFallback(
        'bilibili',
        'single_video_mode',
        normalized.message,
        'bilibili_resolve_failed',
        {
          error: normalized.code,
          fallback: 'single_video_mode',
          traceId: traceContext.traceId,
          diagnosis,
          health: diagnosis.health
        }
      )
    }
  },
  async list(input) {
    const traceContext = createTraceContext(input.shareId, 'list')
    startTrace(traceContext)
    const cached = await getOrRefreshCacheEntry(input.shareId, traceContext)
    if (!cached) {
      return buildFallback(
        'bilibili',
        'episode_cache_miss',
        'B站选集缓存已过期，请重新解析资源后重试',
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
    const cacheTraceContext = createTraceContext(input.shareId, 'download')
    startTrace(cacheTraceContext)
    const cached = await getOrRefreshCacheEntry(input.shareId, cacheTraceContext)
    if (!cached) {
      return providerError(
        'bilibili',
        'episode_cache_miss',
        'B站选集缓存已过期，自动恢复失败，请重新解析资源后重试',
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
        '未找到该文件对应的B站选集，请重新解析资源后重试',
        true,
        'fallback',
        'missing_episode'
      )
    }

    const traceContext = cacheTraceContext

    try {
      debugProvider('download', {
        episodeCount: cached.episodes.length,
        source: 'cache',
        resolvedEpisodeId: episode.id,
        resolvedEpisodeUrl: episode.url,
        traceId: traceContext.traceId
      })
      return providerOk(
        'bilibili',
        await buildDownloadResult(cached.files[index], episode, traceContext),
        'real',
        undefined,
        {
          episodeCount: cached.episodes.length,
          source: 'media',
          resolvedEpisodeId: episode.id,
          resolvedEpisodeUrl: episode.url,
          traceId: traceContext.traceId,
          health: calculateDownloadHealth()
        }
      )
    } catch (error) {
      const normalized = normalizeProviderError('bilibili', error, 'download')
      const insight = getFailureInsight(error, 'media')
      const diagnosis = diagnoseBilibiliFailure([insight], getTrace(traceContext.traceId), getCachedCookieHealth())
      return providerError(
        'bilibili',
        normalized.code,
        normalized.message,
        normalized.recoverable,
        'fallback',
        normalized.code,
        {
          traceId: traceContext.traceId,
          diagnosis,
          health: diagnosis.health
        }
      )
    }
  }
}
