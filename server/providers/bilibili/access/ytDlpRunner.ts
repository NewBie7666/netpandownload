import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { YtDlpInfo } from '../resolver/index.js'
import { normalizeBiliUrl } from '../resolver/index.js'
import { createAccessContext, type AccessContext } from './context.js'
import { buildYtDlpHeaderArgs } from './headers.js'
import {
  BilibiliAccessError,
  classifyAccessError,
  shouldRetryAccess,
  waitBeforeRetry
} from './retryPolicy.js'

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
      // Try next candidate.
    }
  }
  return ''
}

async function runYtDlpOnce(context: AccessContext) {
  const executable = await resolveYtDlpExecutable()
  if (!executable) {
    throw new BilibiliAccessError('dependency_missing', 'yt-dlp executable is unavailable', false)
  }

  const { stdout } = await execFileAsync(
    executable,
    [
      '-J',
      '--yes-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--sleep-interval',
      '1',
      ...buildYtDlpHeaderArgs(context),
      normalizeBiliUrl(context.url)
    ],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      timeout: 8000
    }
  )

  if (!stdout.trim()) {
    throw new BilibiliAccessError('empty_response', 'yt-dlp returned empty response', true)
  }

  try {
    return JSON.parse(stdout) as YtDlpInfo
  } catch (error) {
    throw new BilibiliAccessError('parse_failed', 'yt-dlp returned invalid JSON', true)
  }
}

export async function runYtDlpJson(url: string): Promise<YtDlpInfo> {
  let context = createAccessContext(url)
  let lastError: unknown

  for (;;) {
    try {
      return await runYtDlpOnce(context)
    } catch (error) {
      lastError = error
      if (!shouldRetryAccess(error, context.retryCount)) {
        throw classifyAccessError(error)
      }
      await waitBeforeRetry(context.retryCount)
      context = createAccessContext(url, context.retryCount + 1)
    }
  }

  throw classifyAccessError(lastError)
}
