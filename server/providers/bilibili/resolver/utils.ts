import type { QuarkFile } from '../../../../shared/types.js'
import { AppError } from '../../../http.js'
import type { BiliEpisode } from '../bilibiliNormalizer.js'
import type { StableResolvedShare, YtDlpInfo } from './types.js'

export const cacheTtlMs = 10 * 60 * 1000

export function normalizeInput(input: string) {
  return String(input || '').trim().replace(/^['"]|['"]$/g, '')
}

export function normalizeBiliUrl(input: string) {
  const value = normalizeInput(input)
  try {
    const url = new URL(value)
    const bvMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)
    if (/^(www\.)?bilibili\.com$/i.test(url.hostname) && bvMatch) {
      return `https://www.bilibili.com/video/${bvMatch[1]}`
    }

    if (/^(www\.)?bilibili\.com$/i.test(url.hostname) && /^\/bangumi\/play\//i.test(url.pathname)) {
      return `https://www.bilibili.com${url.pathname.replace(/\/+$/, '')}`
    }

    if (/^b23\.tv$/i.test(url.hostname)) {
      return `https://b23.tv${url.pathname.replace(/\/+$/, '')}`
    }
  } catch {
    return value
  }
  return value
}

export function toStableCacheKey(input: string) {
  return `bili:stable:${normalizeBiliUrl(input)}`
}

export function isBilibiliUrl(input: string) {
  const value = normalizeInput(input)
  try {
    const url = new URL(value)
    if (/^(www\.)?bilibili\.com$/i.test(url.hostname)) {
      return /^\/video\/BV[0-9A-Za-z]+/i.test(url.pathname) || /^\/bangumi\/play\//i.test(url.pathname)
    }
    return /^b23\.tv$/i.test(url.hostname) && url.pathname.length > 1
  } catch {
    return false
  }
}

export function episodeToFile(episode: BiliEpisode): QuarkFile {
  return {
    fid: `bilibili:episode:${episode.id}`,
    name: episode.title,
    size: 0,
    isDir: false,
    createdAt: new Date().toISOString()
  }
}

export function filesFromEpisodes(episodes: BiliEpisode[]) {
  return episodes.map(episodeToFile)
}

export function assertEpisodeConsistency(entry: Pick<StableResolvedShare, 'episodes' | 'files'>) {
  if (entry.episodes.length !== entry.files.length) {
    throw new AppError('episode_inconsistent_state', 'Bilibili episode and file mapping is inconsistent')
  }
}

export function buildResolvedShare(
  inputUrl: string,
  episodes: BiliEpisode[],
  source: StableResolvedShare['source'],
  raw?: YtDlpInfo
): StableResolvedShare {
  const normalizedUrl = normalizeBiliUrl(inputUrl)
  const result: StableResolvedShare = {
    raw,
    episodes,
    files: filesFromEpisodes(episodes),
    normalizedUrl,
    cacheKey: toStableCacheKey(inputUrl),
    source
  }
  assertEpisodeConsistency(result)
  return result
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function getArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function singleEpisodeFromUrl(inputUrl: string): BiliEpisode[] {
  const normalizedUrl = normalizeBiliUrl(inputUrl)
  const bvMatch = normalizedUrl.match(/\/video\/(BV[0-9A-Za-z]+)/i)
  const id = (bvMatch?.[1] || normalizedUrl || 'single-video').replace(/[^0-9A-Za-z:_-]/g, '-')
  return [
    {
      id,
      title: bvMatch?.[1] || 'Bilibili Video',
      url: normalizedUrl,
      index: 1,
      downloadInfo: { webpage_url: normalizedUrl }
    }
  ]
}
