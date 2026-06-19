import type { QuarkFile } from '../../../../shared/types.js'
import type { BiliEpisode } from '../bilibiliNormalizer.js'

export interface YtDlpFormat {
  url?: string
  ext?: string
  filesize?: number
  filesize_approx?: number
  vcodec?: string
  acodec?: string
  protocol?: string
}

export interface YtDlpInfo {
  id?: string
  title?: string
  duration?: number
  webpage_url?: string
  entries?: YtDlpInfo[]
  formats?: YtDlpFormat[]
  requested_downloads?: YtDlpFormat[]
  url?: string
  ext?: string
  filesize?: number
  filesize_approx?: number
  [key: string]: unknown
}

export interface StableResolvedShare {
  raw?: YtDlpInfo
  episodes: BiliEpisode[]
  files: QuarkFile[]
  normalizedUrl: string
  cacheKey: string
  source: 'bangumi' | 'yt-dlp' | 'html' | 'space-search' | 'heuristic'
}

export interface ResolverAttempt {
  ok: boolean
  result?: StableResolvedShare
  error?: unknown
}

export interface ResolveShareOptions {
  runYtDlpJson?: (url: string) => Promise<YtDlpInfo>
  fetchInitialStateJson?: (url: string) => Promise<YtDlpInfo>
  expandShortUrl?: (url: string) => Promise<string>
}
