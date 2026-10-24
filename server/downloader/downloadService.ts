import { mkdir, rm, stat, statfs } from 'node:fs/promises'
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
import { openSafeDownloadFile, resolveSafeDownloadFile } from './privateWebFile.js'
import { validateDirectDownloadInput, validateDownloadFileName } from './directDownload.js'
import { requireTaskAction } from './taskActionPolicy.js'
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
const defaultPrivateWebMinFreeBytes = 1024 * 1024 * 1024

function getMinimumFreeBytes() {
  const raw = String(process.env.NETPAN_MIN_FREE_BYTES || '').trim()
  if (raw) {
    const configured = Number(raw)
    if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured)
  }
  return process.env.NETPAN_PRIVATE_WEB === 'true' ? defaultPrivateWebMinFreeBytes : 0
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
  return process.env.NETPAN_PRIVATE_WEB === 'true'
    ? path.resolve(process.env.NETPAN_DOWNLOAD_DIR || '/srv/netpandownload/downloads')
    : path.join(homedir(), 'Downloads', 'QuarkDownloads')
}

async function ensureDownloadDir(dir = getDefaultDownloadDir()) {
  await mkdir(dir, { recursive: true })
  return dir
}

async function assertMinimumFreeSpace(dir: string) {
  const minimum = getMinimumFreeBytes()
  if (minimum <= 0) return
  let filesystem
  try {
    filesystem = await statfs(dir, { bigint: true })
  } catch {
    throw new AppError('download_disk_unavailable', '无法检查下载目录剩余空间', 503)
  }
  const available = filesystem.bavail * filesystem.bsize
  if (available < BigInt(minimum)) {
    throw new AppError('download_disk_full', `下载目录剩余空间不足（至少需要 ${minimum} 字节）`, 507)
  }
}

async function getEffectiveDownloadDir() {
  const dir = process.env.NETPAN_PRIVATE_WEB === 'true'
    ? getDefaultDownloadDir() : await getConfiguredDownloadDir(getDefaultDownloadDir())
  return ensureDownloadDir(dir)
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

function getDownloadRequestHeaders(normalizedUrl: URL) {
  if (process.env.NETPAN_PRIVATE_WEB === 'true' && normalizedUrl.origin === buildLocalBackendBaseUrl() && normalizedUrl.pathname === '/api/quark/download-proxy') {
    return [`X-Netpan-Token: ${String(process.env.NETPAN_WEB_TOKEN || '')}`]
  }
  const hostname = normalizedUrl.hostname.toLowerCase()
  const instagram = ['cdninstagram.com', 'fbcdn.net'].some((host) => hostname === host || hostname.endsWith('.' + host))
  if (instagram) return ['Referer: https://www.instagram.com/', 'User-Agent: Mozilla/5.0 (compatible; NetPanDownload/1.0)']
  if (hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com')) return ['Referer: https://www.youtube.com/', 'User-Agent: Mozilla/5.0 (compatible; NetPanDownload/1.0)']
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

  return {
    gid: task.gid,
    fileName: filePath ? path.basename(filePath) : task.gid,
    status: (task.status || 'waiting') as DownloadTask['status'],
    totalLength,
    completedLength,
    downloadSpeed,
    progress,
    failureReason: task.status === 'error'
      ? ['9', '16', '17'].includes(task.errorCode || '')
        ? '服务器存储空间不足或无法写入文件，请清理下载目录后重试'
        : ['3', '22'].includes(task.errorCode || '')
          ? '源站拒绝访问或链接已过期（可能为403），请重新解析后下载'
          : '下载中断或源站访问失败，请检查网络并重新解析后重试'
      : undefined,
    dir: task.dir
  }
}

function isPathInside(childPath: string, parentPath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function ensureSafeFileDeletePath(filePath: string) {
  const resolvedFilePath = path.resolve(filePath)
  const allowedDirs = [
    await getEffectiveDownloadDir(),
    await ensureDownloadDir(getDefaultDownloadDir())
  ]

  if (!allowedDirs.some((dir) => isPathInside(resolvedFilePath, dir))) {
    throw new AppError('download_file_delete_forbidden', '只能删除下载目录内的任务文件', 403)
  }

  let fileStat
  try {
    fileStat = await stat(resolvedFilePath)
  } catch {
    throw new AppError('download_file_missing', '未找到该任务对应的本地文件')
  }

  if (!fileStat.isFile()) {
    throw new AppError('download_file_delete_forbidden', '只能删除普通文件，不能删除目录', 403)
  }

  return resolvedFilePath
}

async function deleteTaskFile(task: Aria2TaskPayload) {
  const filePath = String(task.files?.[0]?.path || '').trim()
  if (!filePath) {
    throw new AppError('download_file_missing', '未找到该任务对应的本地文件路径')
  }

  const safePath = await ensureSafeFileDeletePath(filePath)
  try {
    await rm(safePath, { force: false })
  } catch {
    throw new AppError('download_file_delete_failed', '删除本地文件失败')
  }
}

async function submitDownloadTask(input: AddDownloadRequest, direct = false): Promise<AddDownloadResult> {
  if (!getAria2Availability().enabled) {
    throw new AppError('aria2_unavailable', getAria2Availability().message, 503)
  }

  const normalizedUrl = normalizeRequestedDownloadUrl(input.url)
  if (!direct) ensureDownloadUrlAllowed(input.url, normalizedUrl)

  if (process.env.NETPAN_PRIVATE_WEB === 'true' && input.dir) {
    throw new AppError('download_dir_forbidden', '网页模式只允许使用服务器固定下载目录', 403)
  }
  const dir = await ensureDownloadDir(input.dir || (await getEffectiveDownloadDir()))
  await assertMinimumFreeSpace(dir)
  const defaults = getDefaultDownloadOptions(validateDownloadFileName(input.fileName), dir)
  const options = process.env.NETPAN_PRIVATE_WEB === 'true' ? { ...defaults, split: '4', 'max-connection-per-server': '4' } : defaults
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

export async function addDownloadTask(input: AddDownloadRequest): Promise<AddDownloadResult> {
  return submitDownloadTask(input)
}

// Only this separately validated route bypasses Provider URL registration.
export async function addDirectDownloadTask(input: unknown): Promise<AddDownloadResult> {
  if (!getAria2Availability().enabled) {
    throw new AppError('aria2_unavailable', getAria2Availability().message, 503)
  }
  const safe = await validateDirectDownloadInput(input)
  return submitDownloadTask({ url: safe.url, fileName: safe.fileName }, true)
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
  if (process.env.NETPAN_PRIVATE_WEB === 'true') {
    throw new AppError('download_dir_forbidden', '网页模式不能更改服务器下载目录', 403)
  }
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

  const task = await getDownloadTaskStatus(gid)
  if (requireTaskAction('pause', task.status)) await aria2Pause(gid)
  return { gid }
}

export async function resumeDownloadTask(gid: string) {
  const availability = getAria2Availability()
  if (!availability.enabled) {
    throw new AppError('aria2_unavailable', availability.message, 503)
  }

  const task = await getDownloadTaskStatus(gid)
  if (requireTaskAction('resume', task.status)) await aria2Unpause(gid)
  return { gid }
}

export async function removeDownloadTask(gid: string, input: RemoveDownloadRequest = {}) {
  const availability = getAria2Availability()
  if (!availability.enabled) {
    throw new AppError('aria2_unavailable', availability.message, 503)
  }

  const task = await aria2TellStatus(gid)
  if (input.deleteFile) {
    await deleteTaskFile(task)
  }

  if (task.status === 'complete' || task.status === 'error' || task.status === 'removed') {
    await aria2RemoveDownloadResult(gid)
  } else {
    await aria2Remove(gid)
  }

  return { gid }
}

export async function openDownloadDirectory(): Promise<OpenDownloadDirResult> {
  if (process.env.NETPAN_PRIVATE_WEB === 'true') {
    throw new AppError('desktop_only', '云端无法打开本机目录，请在任务完成后点击“保存到此设备”', 403)
  }
  const dir = await getEffectiveDownloadDir()
  spawn('explorer.exe', [dir], {
    detached: true,
    stdio: 'ignore'
  }).unref()
  return { dir }
}

/** Return only a completed aria2 task's file; never accept arbitrary file paths from HTTP clients. */
export async function getCompletedDownloadFile(gid: string) {
  if (!/^[0-9a-f]{16}$/i.test(gid)) throw new AppError('invalid_gid', '任务 ID 格式不正确', 400)
  if (!getAria2Availability().enabled) throw new AppError('aria2_unavailable', '下载引擎不可用', 503)
  const task = await aria2TellStatus(gid)
  if (task.status !== 'complete') throw new AppError('download_not_complete', '任务尚未完成，请稍后重试', 409)
  const pathname = task.files?.[0]?.path || ''
  if (!pathname) throw new AppError('download_file_missing', '任务未关联下载文件', 404)
  return resolveSafeDownloadFile(await getEffectiveDownloadDir(), pathname)
}

export async function openCompletedDownloadFile(gid: string) {
  if (!/^[0-9a-f]{16}$/i.test(gid)) throw new AppError('invalid_gid', '任务 ID 格式不正确', 400)
  if (!getAria2Availability().enabled) throw new AppError('aria2_unavailable', '下载引擎不可用', 503)
  const task = await aria2TellStatus(gid)
  if (task.status !== 'complete') throw new AppError('download_not_complete', '任务尚未完成，请稍后重试', 409)
  const pathname = task.files?.[0]?.path || ''
  if (!pathname) throw new AppError('download_file_missing', '任务未关联下载文件', 404)
  const file = await openSafeDownloadFile(await getEffectiveDownloadDir(), pathname)
  const expected = task.totalLength || ''
  const completed = task.completedLength || ''
  if (!/^\d+$/.test(expected) || !/^\d+$/.test(completed) || BigInt(expected) !== BigInt(completed) || BigInt(expected) !== BigInt(file.size) || task.files?.length !== 1) {
    await file.handle.close()
    throw new AppError('download_file_incomplete', '任务文件大小与已完成记录不一致，请重新下载', 409)
  }
  return file
}
