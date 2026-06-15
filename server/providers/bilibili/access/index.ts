import { AppError } from '../../../http.js'
import { normalizeBiliUrl } from '../resolver/index.js'
import type { YtDlpInfo } from '../resolver/index.js'
import { createAccessContext } from './context.js'
import { buildBilibiliHeaders } from './headers.js'
import {
  BilibiliAccessError,
  classifyAccessError,
  shouldRetryAccess,
  waitBeforeRetry
} from './retryPolicy.js'
import { runYtDlpJson } from './ytDlpRunner.js'

function toAppError(error: unknown): AppError {
  const classified = classifyAccessError(error)
  if (classified.reason === 'dependency_missing') {
    return new AppError('ytdlp_unavailable', classified.message)
  }
  if (classified.reason === 'restricted') {
    return new AppError('bilibili_access_restricted', classified.message)
  }
  if (classified.reason === '412_or_network_block') {
    return new AppError('bilibili_blocked_by_upstream', classified.message)
  }
  if (classified.reason === 'network_error') {
    return new AppError('bilibili_network_error', classified.message)
  }
  return new AppError('bilibili_access_failed', `${classified.message}: ${classified.reason}`)
}

export async function resolveBilibiliAccess(url: string): Promise<YtDlpInfo> {
  try {
    return await runYtDlpJson(url)
  } catch (error) {
    throw toAppError(error)
  }
}

async function expandOnce(url: string, retryCount: number) {
  const context = createAccessContext(url, retryCount)
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: buildBilibiliHeaders(context),
    signal: AbortSignal.timeout(5000)
  })
  if (response.status === 412) {
    throw new BilibiliAccessError('412_or_network_block', 'Bilibili short URL expansion was blocked', true, 412)
  }
  return normalizeBiliUrl(response.url || url)
}

export async function expandBilibiliShortUrl(url: string) {
  let retryCount = 0
  for (;;) {
    try {
      return await expandOnce(url, retryCount)
    } catch (error) {
      if (!shouldRetryAccess(error, retryCount)) {
        return normalizeBiliUrl(url)
      }
      await waitBeforeRetry(retryCount)
      retryCount += 1
    }
  }
}

export { BilibiliAccessError, runYtDlpJson }
