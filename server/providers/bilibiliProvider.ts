import type { DownloadResult, QuarkFile } from '../../shared/types.js'
import { registerAllowedDownloadResult } from '../downloader/downloadService.js'
import type { Provider } from './types.js'

const mockFiles: QuarkFile[] = [
  {
    fid: 'bilibili:mock:episode-1',
    name: 'Bilibili Mock 分P 1.mp4',
    size: 24 * 1024 * 1024,
    isDir: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString()
  },
  {
    fid: 'bilibili:mock:episode-2',
    name: 'Bilibili Mock 分P 2.mp4',
    size: 32 * 1024 * 1024,
    isDir: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString()
  }
]

function normalizeInput(input: string) {
  return String(input || '').trim().replace(/^['"]|['"]$/g, '')
}

function isBilibiliUrl(input: string) {
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

function buildMockDownloadResult(file: QuarkFile): DownloadResult {
  const result: DownloadResult = {
    fid: file.fid,
    name: file.name,
    downloadUrl: `https://mock.local/bilibili/${encodeURIComponent(file.fid)}`,
    source: 'direct',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    cached: false
  }
  registerAllowedDownloadResult(result)
  return result
}

export const bilibiliProvider: Provider = {
  id: 'bilibili',
  name: 'Bilibili',
  match(input) {
    return isBilibiliUrl(input)
  },
  async resolveShare(input) {
    // V0.7 mock Provider: validates registry and downloader compatibility only.
    // This does not call real Bilibili APIs or represent real download support.
    return {
      shareId: normalizeInput(input.shareUrl),
      stoken: 'bilibili-mock-token',
      path: [],
      files: mockFiles
    }
  },
  async list() {
    // V0.7 mock Provider: real Bilibili pages, DASH, auth, and ffmpeg remain future work.
    return {
      files: mockFiles
    }
  },
  async getDownload(input) {
    const file = mockFiles.find((item) => item.fid === input.file?.fid) || input.file || mockFiles[0]
    return buildMockDownloadResult(file)
  }
}
