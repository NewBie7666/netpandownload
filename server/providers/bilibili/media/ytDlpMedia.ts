import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { AppError } from '../../../http.js'
import { createAccessContext } from '../access/context.js'
import { buildYtDlpHeaderArgs } from '../access/headers.js'
import { normalizeBiliUrl } from '../resolver/index.js'
import { classifyFailure, withFailureLayer } from '../stability/index.js'
import type { ResolveMediaOptions } from './types.js'

const execFileAsync = promisify(execFile)

function getYtDlpCandidates() {
  const configured = String(process.env.YTDLP_PATH || '').trim()
  const desktopRoot = String(process.env.QUARK_DESKTOP_ROOT || '').trim()
  const resourcesPath = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '').trim()
  return Array.from(
    new Set(
      [
        configured,
        path.resolve(process.cwd(), 'resources', 'yt-dlp', 'win', 'yt-dlp.exe'),
        desktopRoot ? path.resolve(desktopRoot, 'resources', 'yt-dlp', 'win', 'yt-dlp.exe') : '',
        resourcesPath ? path.resolve(resourcesPath, 'yt-dlp', 'win', 'yt-dlp.exe') : ''
      ].filter(Boolean)
    )
  )
}

async function resolveYtDlpExecutable() {
  for (const candidate of getYtDlpCandidates()) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return ''
}

function pickMediaUrl(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//i.test(line))
}

function toMediaError(error: unknown) {
  const failure = classifyFailure(error)
  if (failure.type === 'dependency_missing') {
    return new AppError('ytdlp_unavailable', '未找到 yt-dlp，无法解析 B站媒体直链')
  }
  if (failure.type === 'yt_dlp_timeout' || failure.type === 'network_error') {
    return new AppError('media_extract_timeout', 'B站媒体直链解析超时或网络失败')
  }
  if (failure.type === 'bilibili_412' || failure.type === 'rate_limited') {
    return new AppError('media_resolution_failed', 'B站返回风控限制，无法解析媒体直链')
  }
  if (failure.type === 'restricted') {
    return new AppError('media_resolution_failed', '该 B站资源需要更高登录状态或访问权限')
  }
  return new AppError('media_resolution_failed', failure.message || 'B站媒体直链解析失败')
}

export async function runYtDlpMediaUrl(episodeUrl: string, options: ResolveMediaOptions = {}) {
  const executable = await resolveYtDlpExecutable()
  if (!executable) {
    throw new AppError('ytdlp_unavailable', '未找到 yt-dlp，无法解析 B站媒体直链')
  }

  const context = options.accessContext || createAccessContext(episodeUrl)
  try {
    const { stdout } = await withFailureLayer('ytDlp', () => execFileAsync(
      executable,
      [
        '-f',
        'best',
        '-g',
        '--no-warnings',
        '--no-playlist',
        '--no-check-certificate',
        '--sleep-interval',
        '1',
        ...buildYtDlpHeaderArgs(context),
        normalizeBiliUrl(context.url)
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        timeout: options.timeoutMs || 12000
      }
    ))

    const url = pickMediaUrl(stdout)
    if (!url) {
      throw new AppError('media_resolution_failed', 'B站未返回可下载媒体直链')
    }
    return url
  } catch (error) {
    throw toMediaError(error)
  }
}
