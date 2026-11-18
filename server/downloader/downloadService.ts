import { mkdir } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { prepareTaskFileDeletion, deletePreparedTaskFiles } from './taskFileDeletion.js'
import { btDownloadOptions, infoHashFromMagnet, metadataDiagnostic, normalizeBtih } from './btSupport.js'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type {
  AddDownloadRequest,
  AddDownloadResult,
  DownloadHealthResult,
  DownloadSettingsResult,
  DownloadResult,
  DownloadTask,
  DownloadTasksResult,
  OpenDownloadDirResult,
  RemoveDownloadRequest
} from '../../shared/types.js'
import { getRuntimePort } from '../config.js'
import { AppError } from '../http.js'
import {
  getConfiguredDownloadDir,
  getDownloadSettings as readDownloadSettings,
  saveDownloadSettings
} from './settings.js'
import {
  aria2AddUri,
  aria2Pause,
  aria2Remove,
  aria2RemoveDownloadResult,
  aria2SaveSession,
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
const downloadTaskHistorySize = 50
const btNames = new Map<string, string>()
const btFirstSeen = new Map<string, number>()
let btAddSerial: Promise<unknown> = Promise.resolve()

function runBtAddSerial<T>(callback: () => Promise<T>): Promise<T> {
  const current = btAddSerial.then(callback, callback)
  btAddSerial = current.catch(() => undefined)
  return current
}

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

async function getEffectiveDownloadDir() {
  return ensureDownloadDir(await getConfiguredDownloadDir(getDefaultDownloadDir()))
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
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'magnet:') {
      const xt = parsed.searchParams.get('xt') || ''
      if (!/^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt)) {
        throw new AppError('invalid_magnet', '无效的 BT 磁力链接')
      }
      return parsed
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError('invalid_download_url', '只允许 HTTP(S) 或 BT 磁力链接')
    }
    return parsed
  } catch (error) {
    if (error instanceof AppError) throw error
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

function getDownloadRequestHeaders(normalizedUrl: URL) {
  const hostname = normalizedUrl.hostname.toLowerCase()
  if (hostname === 'video.twimg.com') {
    return [
      'Referer: https://x.com/',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    ]
  }
  if (!hostname.endsWith('bilivideo.com')) {
    return []
  }

  return [
    'Referer: https://www.bilibili.com',
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  ]
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
  const hash = normalizeBtih(task.infoHash || '') || infoHashFromMagnet(filePath)
  const isTorrent = Boolean(hash || task.bittorrent || btNames.has(task.gid) || /[[]METADATA[]]/i.test(filePath))
  const hasMetadata = Boolean(task.bittorrent?.info?.name) || (isTorrent && totalLength > 0)
  const metadataPending = isTorrent && !hasMetadata && task.status !== 'complete' && task.status !== 'error'
  if (metadataPending && !btFirstSeen.has(task.gid)) btFirstSeen.set(task.gid, Date.now())
  if (!metadataPending) btFirstSeen.delete(task.gid)
  const elapsed = metadataPending ? Math.floor((Date.now() - (btFirstSeen.get(task.gid) || Date.now())) / 1000) : 0
  const connections = toNumber(task.connections)
  const seeders = toNumber(task.numSeeders)
  const friendlyName = task.bittorrent?.info?.name || btNames.get(task.gid) ||
    (filePath && !/[[]METADATA[]]/i.test(filePath) ? path.basename(filePath) : '') ||
    (isTorrent ? 'BT元数据获取中' : task.gid)
  return {
    gid: task.gid,
    fileName: friendlyName,
    status: (task.status || 'waiting') as DownloadTask['status'],
    totalLength, completedLength, downloadSpeed, progress,
    dir: task.dir,
    isTorrent,
    infoHash: hash || undefined,
    metadataPending,
    metadataElapsedSeconds: metadataPending ? elapsed : undefined,
    connections: isTorrent ? connections : undefined,
    numSeeders: isTorrent ? seeders : undefined,
    errorCode: task.errorCode || undefined,
    errorMessage: task.errorMessage || undefined,
    diagnosis: task.errorMessage || (metadataPending ? metadataDiagnostic(elapsed, connections, seeders) : undefined),
    followedBy: task.followedBy
  }
}

export async function addDownloadTask(input: AddDownloadRequest): Promise<AddDownloadResult> {
  if (!getAria2Availability().enabled) {
    throw new AppError('aria2_unavailable', getAria2Availability().message, 503)
  }

  const normalizedUrl = normalizeRequestedDownloadUrl(input.url)
  ensureDownloadUrlAllowed(input.url, normalizedUrl)

  const dir = await ensureDownloadDir(input.dir || (await getEffectiveDownloadDir()))
  if (normalizedUrl.protocol === 'magnet:') {
    const infoHash = infoHashFromMagnet(normalizedUrl.toString())
    if (!infoHash) throw new AppError('invalid_magnet', 'BT Info Hash 不合法')
    return runBtAddSerial(async () => {
      const existing = [...await aria2TellActive(), ...await aria2TellWaiting(0, 100), ...await aria2TellStopped(0, 100)]
        .find(task => normalizeBtih(task.infoHash || '') === infoHash &&
          task.status !== 'error' && task.status !== 'removed')
      if (existing) {
        return { gid: existing.gid, duplicate: true }
      }
      const gid = await aria2AddUri(normalizedUrl.toString(), btDownloadOptions(dir))
      const title = String(input.fileName || '').trim()
      if (title) btNames.set(gid, title.slice(0, 240))
      btFirstSeen.set(gid, Date.now())
      return { gid, duplicate: false }
    })
  }

  // Preserve HTTP download settings; BitTorrent-only options must not leak here.
  const options = getDefaultDownloadOptions(input.fileName, dir)
  const rpcOptions = options.out ? options : { ...options, out: undefined }
  const headers = getDownloadRequestHeaders(normalizedUrl)
  const optionsWithHeaders = headers.length ? { ...rpcOptions, header: headers } : rpcOptions
  const sanitizedOptions = Object.entries(optionsWithHeaders).reduce<Record<string, string | string[]>>(
    (result, [key, value]) => {
      if (typeof value === 'string' && value) {
        result[key] = value
      } else if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item)) {
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
  const defaultDir = await getEffectiveDownloadDir()

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

export async function getDownloadHealth(): Promise<DownloadHealthResult> {
  const availability = getAria2Availability()
  const defaultDir = await getEffectiveDownloadDir()

  return {
    enabled: availability.enabled,
    message: availability.enabled ? undefined : availability.message,
    defaultDir
  }
}

export async function getDownloadSettings(): Promise<DownloadSettingsResult> {
  return readDownloadSettings(getDefaultDownloadDir())
}

export async function updateDownloadSettings(input: { downloadDir?: string }): Promise<DownloadSettingsResult> {
  return saveDownloadSettings(input, getDefaultDownloadDir())
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

/**
 * aria2.remove() moves active, paused and waiting tasks to the stopped list.
 * Remove the stopped record too; otherwise users still see a "Removed" task.
 */
async function clearAria2TaskRecord(gid: string, status: string): Promise<void> {
  if (status !== 'complete' && status !== 'error' && status !== 'removed') {
    await aria2Remove(gid)
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      await aria2RemoveDownloadResult(gid)
      return
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      // The task may have already been removed by aria2 itself.
      if (/GID.*not found|GID.*not exist|not found.*GID/i.test(message)) return
      if (attempt < 15) await sleep(150)
    }
  }
  throw new AppError(
    'download_record_delete_failed',
    '已停止下载，但 aria2 尚未清除任务记录：' + (lastError instanceof Error ? lastError.message : '请重试'),
    502
  )
}

export async function removeDownloadTask(gid: string, input: RemoveDownloadRequest = {}) {
  const availability = getAria2Availability()
  if (!availability.enabled) {
    throw new AppError('aria2_unavailable', availability.message, 503)
  }

  const task = await aria2TellStatus(gid)
  // Validate manifest paths *before* removing anything. Never delete an entire
  // BT folder: every target must be an individual aria2-reported regular file.
  const targets = input.deleteFile
    ? await prepareTaskFileDeletion(
      (task.files || []).map(file => String(file.path || '')),
      [await getEffectiveDownloadDir(), await ensureDownloadDir(getDefaultDownloadDir())]
    )
    : []

  // On Windows deleting an active or paused file first often fails with EPERM.
  // Stop the transfer, clear its history record, then release/delete its files.
  await clearAria2TaskRecord(gid, task.status)
  btNames.delete(gid)
  btFirstSeen.delete(gid)
  // Persist the removal so stale tasks do not reappear next time the EXE starts.
  await aria2SaveSession().catch(() => undefined)

  if (!input.deleteFile) return { gid, deletedFiles: 0 }

  try {
    const deletedFiles = await deletePreparedTaskFiles(targets)
    return { gid, deletedFiles }
  } catch (error) {
    // Removing the task record was successful, but Windows may still hold a lock
    // or another app may be using the file. Report the partial outcome honestly.
    return {
      gid,
      deletedFiles: 0,
      warning: error instanceof Error
        ? '任务记录已删除，但部分本地文件未能删除：' + error.message
        : '任务记录已删除，但部分本地文件未能删除，请手动检查下载目录。'
    }
  }
}

export async function openDownloadDirectory(): Promise<OpenDownloadDirResult> {
  const dir = await getEffectiveDownloadDir()
  spawn('explorer.exe', [dir], {
    detached: true,
    stdio: 'ignore'
  }).unref()
  return { dir }
}
