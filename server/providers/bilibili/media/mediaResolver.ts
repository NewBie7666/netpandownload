import { AppError } from '../../../http.js'
import { createAccessContext } from '../access/context.js'
import { createTraceEvent, recordTraceEvent, traceStage } from '../observability/index.js'
import {
  getFailureInsight,
  recordMediaFailure,
  recordMediaSuccess,
  throttleBilibiliRequest,
  toBilibiliFailSafeError,
  withBilibiliRetry,
  withFailureLayer
} from '../stability/index.js'
import { resolvePlayUrlMedia } from './playUrlMedia.js'
import { runYtDlpMediaUrl } from './ytDlpMedia.js'
import type { BilibiliMediaResult, ResolveMediaOptions } from './types.js'

const mediaUrlTtlMs = 10 * 60 * 1000

async function resolveTemporaryMediaUrl(normalizedUrl: string, options: ResolveMediaOptions) {
  const accessContext = options.accessContext || createAccessContext(normalizedUrl)
  recordTraceEvent(options.traceContext, createTraceEvent('auth', 'success'))
  await throttleBilibiliRequest(accessContext.episodeSessionId || normalizedUrl)

  return withBilibiliRetry(async () => traceStage(
    options.traceContext,
    'media',
    async () => {
      try {
        return await withFailureLayer('mediaResolver', () => resolvePlayUrlMedia(normalizedUrl, options.episodeInfo, accessContext))
      } catch {
        return withFailureLayer('mediaExtractor', () => runYtDlpMediaUrl(normalizedUrl, { ...options, accessContext }))
      }
    },
    recordTraceEvent
  ), undefined, {
    context: 'media',
    onDegrade: () => {
      accessContext.cookies = undefined
    },
    onStateChange: (state) => {
      if (state === 'retry_once') recordTraceEvent(options.traceContext, createTraceEvent('retry', 'start'))
      if (state === 'degrade_mode') recordTraceEvent(options.traceContext, createTraceEvent('retry', 'degraded'))
      if (state === 'give_up') recordTraceEvent(options.traceContext, createTraceEvent('retry', 'fail'))
      if (state === 'success') recordTraceEvent(options.traceContext, createTraceEvent('retry', 'success'))
    }
  })
}

export async function resolveMedia(episodeUrl: string, options: ResolveMediaOptions = {}): Promise<BilibiliMediaResult> {
  const normalizedUrl = String(episodeUrl || '').trim()
  if (!normalizedUrl) {
    throw new AppError('media_resolution_failed', 'B站单集地址为空，无法解析媒体直链')
  }

  try {
    const url = await resolveTemporaryMediaUrl(normalizedUrl, options)
    recordMediaSuccess()
    return {
      url,
      expiresAt: new Date(Date.now() + mediaUrlTtlMs).toISOString()
    }
  } catch (error) {
    recordMediaFailure(getFailureInsight(error, 'media'))
    throw toBilibiliFailSafeError(error, 'media')
  }
}
