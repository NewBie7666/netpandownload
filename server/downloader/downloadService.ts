import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type {
  AddDownloadRequest,
  AddDownloadResult,
  DownloadResult,
  DownloadTask,
  DownloadTasksResult,
  OpenDownloadDirResult
} from '../../shared/types.js'
import { getRuntimePort } from '../config.js'
import { AppError } from '../http.js'
import {
  aria2AddUri,
  aria2Pause,
  aria2Remove,
  aria2RemoveDownloadResult,
  aria2TellActive,
  aria2TellStatus,
  aria2TellStopped,
  aria2TellWaiting,
  aria2Unpause,
  getAria2Availability,
  getDefaultDownloadOptions,
  type Aria2TaskPayload
} from './aria2Client.js'

const allowedDownloadUrlCache = new Map<string, number>()
const allowedDownloadUrlTtlMs = 30 * 60 * 1000
const downloadTaskHistorySize = 20

function cleanupAllowedUrls() {
  const now = Date.now()
  for (const [url, expiresAt] of allowedDownloadUrlCache.entries()) {
    if (expiresAt <= now) {
      allowedDownloadUrlCache.delete(url)
    }
  }
}

export function getDefaultDownloadDir() {
  return path.join(homedir(), 'Downloads', 'QuarkDownloads')
}

async function ensureDownloadDir(dir = getDefaultDownloadDir()) {
  await mkdir(dir, { recursive: true })
  return dir
}

function buildLocalBackendBaseUrl() {
  return `http://127.0.0.1:${getRuntimePort()}`
}

function buildLocalProxyCandidates(url: string) {
  const trimmed = String(url || '').trim()
  if (!trimmed) return []

  const candidates = new Set<string>()
  const baseUrl = buildLocalBackendBaseUrl()

  if (trimmed.startsWith('/api/quark/download-proxy?token=')) {
    candidates.add(trimmed)
    candidates.add(new URL(trimmed, `${baseUrl}/`).toString())
    return Array.from(candidates)
  }

  try {
    const normalized = new URL(trimmed)
    candidates.add(normalized.toString())
  } catch {
    return []
  }

  return Array.from(candidates)
}

export function registerAllowedDownloadUrl(url: string, expiresAt?: number) {
  const validUntil = expiresAt && Number.isFinite(expiresAt) ? expiresAt : Date.now() + allowedDownloadUrlTtlMs
  for (const candidate of buildLocalProxyCandidates(url)) {
    allowedDownloadUrlCache.set(candidate, validUntil)
  }
}

export function registerAllowedDownloadResult(result: DownloadResult) {
  const expiresAt = Date.parse(result.expiresAt)
  if (result.downloadUrl) {
    registerAllowedDownloadUrl(result.downloadUrl, expiresAt)
  }
  if (result.proxyUrl) {
    registerAllowedDownloadUrl(result.proxyUrl, expiresAt)
  }
}

function normalizeRequestedDownloadUrl(input: string) {
  const trimmed = String(input || '').trim()
  if (!trimmed) {
    throw new AppError('invalid_download_url', '下载地址不能为空')
  }

  if (trimmed.startsWith('/api/quark/download-proxy?token=')) {
    return new URL(trimmed, `${buildLocalBackendBaseUrl()}/`)
  }

  try {
    return new URL(trimmed)
  } catch {
    throw new AppError('invalid_download_url', '下载地址格式不正确')
  }
}

function ensureDownloadUrlAllowed(rawUrl: string, normalizedUrl: URL) {
  cleanupAllowedUrls()

  const variants = new Set<string>([normalizedUrl.toString(), String(rawUrl || '').trim()])
  if (normalizedUrl.pathname === '/api/quark/download-proxy') {
    variants.add(normalizedUrl.pathname + normalizedUrl.search)
  }

  for (const candidate of variants) {
    const expiresAt = allowedDownloadUrlCache.get(candidate)
    if (expiresAt && expiresAt > Date.now()) {
      return
    }
  }

  throw new AppError('download_url_not_allowed', '该下载地址未通过当前应用授权，无法加入内置下载器', 403)
}

function toNumber(value: string | undefined) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeTask(task: Aria2TaskPayload): DownloadTask {
  const totalLength = toNumber(task.totalLength)
  const completedLength = toNumber(task.completedLength)
  const downloadSpeed = toNumber(task.downloadSpeed)
  const progress = totalLength > 0 ? Math.min(100, Math.round((completedLength / totalLength) * 100)) : 0
  const filePath = task.files?.[0]?.path || ''

  return {
    gid: task.gid,
    fileName: filePath ? path.basename(filePath) : task.gid,
    status: (task.status || 'waiting') as DownloadTask['status'],
    totalLength,
    completedLength,
    downloadSpeed,
    progress,
    dir: task.dir
  }
}

export async function addDownloadTask(input: AddDownloadRequest): Promise<AddDownloadResult> {
  if (!getAria2Availability().enabled) {
    throw new AppError('aria2_unavailable', getAria2Availability().message, 503)
  }

  const normalizedUrl = normalizeRequestedDownloadUrl(input.url)
  ensureDownloadUrlAllowed(input.url, normalizedUrl)

  const dir = await ensureDownloadDir(input.dir || getDefaultDownloadDir())
  const options = getDefaultDownloadOptions(input.fileName, dir)
  const rpcOptions = options.out ? options : { ...options, out: undefined }
  const sanitizedOptions = Object.entries(rpcOptions).reduce<Record<string, string>>(
    (result, [key, value]) => {
      if (typeof value === 'string' && value) {
        result[key] = value
      }
      return result
    },
    {}
  )

  const gid = await aria2AddUri(normalizedUrl.toString(), sanitizedOptions)
  return { gid }
}

export async function listDownloadTasks(): Promise<DownloadTasksResult> {
  const availability = getAria2Availability()
  const defaultDir = await ensureDownloadDir()

  if (!availability.enabled) {
    return {
      enabled: false,
      message: availability.message,
      defaultDir,
      tasks: []
    }
  }

  const [active, waiting, stopped] = await Promise.all([
    aria2TellActive(),
    aria2TellWaiting(0, downloadTaskHistorySize),
    aria2TellStopped(0, downloadTaskHistorySize)
  ])

  const tasks = [...active, ...waiting, ...stopped].map(normalizeTask)

  return {
    enabled: true,
    defaultDir,
    tasks
  }
}

export async function getDownloadTaskStatus(gid: string) {
  const availability = getAria2Availability()
  if (!availability.enabled) {
    throw new AppError('aria2_unavailable', availability.message, 503)
  }

  return normalizeTask(await aria2TellStatus(gid))
}

export async function pauseDownloadTask(gid: string) {
  const availability = getAria2Availability()
  if (!availability.enabled) {
    throw new AppError('aria2_unavailable', availability.message, 503)
  }

  await aria2Pause(gid)
  return { gid }
}

export async function resumeDownloadTask(gid: string) {
  const availability = getAria2Availability()
  if (!availability.enabled) {
    throw new AppError('aria2_unavailable', availability.message, 503)
  }

  await aria2Unpause(gid)
  return { gid }
}

export async function removeDownloadTask(gid: string) {
  const availability = getAria2Availability()
  if (!availability.enabled) {
    throw new AppError('aria2_unavailable', availability.message, 503)
  }

  const task = await aria2TellStatus(gid)
  if (task.status === 'complete' || task.status === 'error' || task.status === 'removed') {
    await aria2RemoveDownloadResult(gid)
  } else {
    await aria2Remove(gid)
  }

  return { gid }
}

export async function openDownloadDirectory(): Promise<OpenDownloadDirResult> {
  const dir = await ensureDownloadDir()
  spawn('explorer.exe', [dir], {
    detached: true,
    stdio: 'ignore'
  }).unref()
  return { dir }
}
