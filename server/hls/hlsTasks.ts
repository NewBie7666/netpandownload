import { randomBytes } from 'node:crypto'
import { createDecipheriv } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { DownloadTask } from '../../shared/types.js'
import { AppError } from '../http.js'
import { getConfiguredDownloadDir } from '../downloader/settings.js'
import { validateDownloadFileName } from '../downloader/directDownload.js'
import { validateVideoSourceUrl } from '../video-sources/network.js'
import { hlsIv, parseHlsMediaPlaylist, selectHlsVariant } from './hlsParser.js'
import { readHlsResource } from './hlsNetwork.js'
import { openSafeDownloadFile } from '../downloader/privateWebFile.js'

interface HlsJob {
  gid: string
  url: string
  fileName: string
  status: DownloadTask['status']
  progress: number
  segmentCount: number
  completedSegments: number
  completedLength: number
  downloadSpeed: number
  totalLength: number
  error?: string
  filePath?: string
  createdAt: number
}
const maxTasks = 40
const jobs = new Map<string, HlsJob>()
const controllers = new Map<string, AbortController>()
const queue: string[] = []
let busy = false
let loaded = false
let snapshotWrites = Promise.resolve()

function fail(code: string, message: string, status = 400): never {
  throw new AppError(code, message, status)
}
export function isHlsGid(gid: string): boolean {
  return /^hls-[0-9a-f]{16}$/.test(gid)
}
async function rootDir(): Promise<string> {
  const root = process.env.NETPAN_PRIVATE_WEB === 'true'
    ? path.resolve(process.env.NETPAN_DOWNLOAD_DIR || '/srv/netpandownload/downloads')
    : await getConfiguredDownloadDir(path.join(homedir(), 'Downloads', 'QuarkDownloads'))
  await mkdir(root, { recursive: true })
  return root
}
async function journalPath() { return path.join(await rootDir(), '.hls-tasks.json') }
async function persist(): Promise<void> {
  const data = JSON.stringify([...jobs.values()].slice(-maxTasks), null, 2)
  // Serialize snapshots to prevent an older async write overwriting newer state.
  snapshotWrites = snapshotWrites.catch(() => {}).then(async () => {
    const target = await journalPath()
    const temp = target + '.' + randomBytes(6).toString('hex')
    await writeFile(temp, data, { mode: 0o600 })
    await rename(temp, target)
  })
  return snapshotWrites
}
async function init() {
  if (loaded) return
  loaded = true
  try {
    const saved: unknown = JSON.parse(await readFile(await journalPath(), 'utf8'))
    if (!Array.isArray(saved)) return
    for (const candidate of saved.slice(-maxTasks)) {
      const item = candidate as HlsJob
      if (!item || !isHlsGid(item.gid) || typeof item.fileName !== 'string') continue
      if (!['error', 'removed', 'complete'].includes(item.status)) {
        item.status = 'error'
        item.error = '服务重启中断了 HLS 任务，请重新提交（不保留部分分片）'
      }
      jobs.set(item.gid, item)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
function view(job: HlsJob): DownloadTask {
  return {
    gid: job.gid, fileName: job.fileName, status: job.status,
    progress: job.progress, totalLength: job.totalLength,
    completedLength: job.completedLength, downloadSpeed: job.downloadSpeed,
    failureReason: job.error
  }
}
async function freeSpace(dir: string) {
  const size = await statfs(dir, { bigint: true })
  const minimum = BigInt(process.env.NETPAN_PRIVATE_WEB === 'true' ? 1024 * 1024 * 1024 : 128 * 1024 * 1024)
  if (size.bavail * size.bsize < minimum) fail('hls_disk_full', 'HLS 可用磁盘空间不足', 507)
}
export async function enqueueHls(input: unknown): Promise<{ gid: string, fileName: string }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('hls_invalid', 'HLS 下载参数不正确')
  const body = input as Record<string, unknown>
  const url = validateVideoSourceUrl(body.url).toString()
  if (!/\.m3u8$/i.test(new URL(url).pathname)) fail('hls_invalid', 'HLS 下载地址必须以 .m3u8 结尾')
  const name = validateDownloadFileName(body.fileName)
  if (name && !/\.mp4$/i.test(name)) fail('hls_filename', 'HLS 输出文件名必须以 .mp4 结尾')
  const fileName = name || 'HLS-' + Date.now() + '.mp4'
  await init()
  if ([...jobs.values()].filter(j => j.status === 'waiting' || j.status === 'active').length >= 4) {
    fail('hls_queue_full', '最多同时排队 4 个 HLS 任务', 429)
  }
  const dir = await rootDir()
  await freeSpace(dir)
  const gid = 'hls-' + randomBytes(8).toString('hex')
  jobs.set(gid, { gid, url, fileName, status: 'waiting', progress: 0,
    segmentCount: 0, completedSegments: 0, completedLength: 0, downloadSpeed: 0,
    totalLength: 0, createdAt: Date.now() })
  await persist()
  queue.push(gid)
  void pump()
  return { gid, fileName }
}

export async function runFfmpeg(input: string, output: string, signal: AbortSignal): Promise<void> {
  const binary = String(process.env.NETPAN_FFMPEG_PATH || 'ffmpeg')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-y', '-protocol_whitelist', 'file', '-i', input,
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', output
    ], { stdio: ['ignore', 'ignore', 'pipe'], signal })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000) })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg 本地封装失败: ' + stderr.slice(-250))))
  })
}

async function execute(job: HlsJob, signal: AbortSignal): Promise<void> {
  const root = await rootDir()
  const scratch = await mkdtemp(path.join(root, '.hls-work-'))
  const joined = path.join(scratch, 'joined.ts')
  const temporaryOutput = path.join(scratch, 'converted.mp4')
  let finalOutput = ''
  let total = 0
  try {
    await freeSpace(root)
    let url = job.url
    let playlistText = ''
    for (let depth = 0; depth <= 3; depth++) {
      const response = await readHlsResource(url, 1_000_000, signal, new URL(job.url).origin + '/')
      playlistText = response.data.toString('utf8')
      const variant = selectHlsVariant(playlistText, response.url)
      if (!variant) { url = response.url; break }
      if (depth === 3) fail('hls_master_depth', 'HLS 主清单嵌套超过上限', 422)
      url = variant
    }
    const manifest = parseHlsMediaPlaylist(playlistText, url)
    job.segmentCount = manifest.segments.length
    await persist()
    const keys = new Map<string, Buffer>()
    await writeFile(joined, Buffer.alloc(0), { flag: 'wx' })
    const startedAt = Date.now()
    for (const segment of manifest.segments) {
      if (signal.aborted) fail('hls_aborted', '任务已暂停或取消', 409)
      const response = await readHlsResource(segment.url, 32 * 1024 * 1024, signal, new URL(url).origin + '/')
      let buffer = response.data
      if (segment.keyUrl) {
        let key = keys.get(segment.keyUrl)
        if (!key) {
          key = (await readHlsResource(segment.keyUrl, 16, signal, new URL(url).origin + '/')).data
          if (key.length !== 16) fail('hls_invalid_key', 'HLS AES-128 密钥长度必须为 16 字节', 422)
          keys.set(segment.keyUrl, key)
        }
        const decryptor = createDecipheriv('aes-128-cbc', key, hlsIv(segment))
        buffer = Buffer.concat([decryptor.update(buffer), decryptor.final()])
      }
      if (buffer.length < 188 || buffer[0] !== 0x47) {
        fail('hls_invalid_segment', '媒体分片不是预期的 MPEG-TS 数据', 422)
      }
      total += buffer.length
      if (total > 4 * 1024 * 1024 * 1024) fail('hls_size_limit', 'HLS 下载超过 4GiB 上限', 413)
      await appendFile(joined, buffer)
      job.completedSegments++
      job.completedLength = total
      job.downloadSpeed = Math.floor(total / Math.max(1, (Date.now() - startedAt) / 1000))
      job.progress = Math.min(95, Math.floor(job.completedSegments / job.segmentCount * 95))
      if (job.completedSegments % 10 === 0) await freeSpace(root)
    }
    await runFfmpeg(joined, temporaryOutput, signal)
    const result = await stat(temporaryOutput)
    if (result.size < 188) fail('hls_empty_output', '合并后文件为空或损坏', 502)
    const base = job.fileName.replace(/\.mp4$/i, '')
    finalOutput = path.join(root, base + '-' + job.gid.slice(-8) + '.mp4')
    await rename(temporaryOutput, finalOutput)
    job.filePath = finalOutput
    job.fileName = path.basename(finalOutput)
    job.totalLength = result.size
    job.completedLength = result.size
    job.progress = 100
    job.downloadSpeed = 0
    job.status = 'complete'
    await persist()
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
async function pump() {
  if (busy) return
  busy = true
  try {
    while (queue.length) {
      const id = queue.shift()!
      const job = jobs.get(id)
      if (!job || job.status !== 'waiting') continue
      job.status = 'active'
      const controller = new AbortController()
      controllers.set(id, controller)
      await persist()
      try { await execute(job, controller.signal) }
      catch (e) {
        if (!['removed', 'paused'].includes(job.status)) {
          job.status = 'error'
          job.error = e instanceof Error ? e.message.slice(0, 280) : 'HLS 下载失败'
        }
        job.downloadSpeed = 0
        await persist()
      } finally { controllers.delete(id) }
    }
  } finally { busy = false }
}
export async function listHlsTasks(): Promise<DownloadTask[]> {
  await init()
  return [...jobs.values()].filter(j => j.status !== 'removed').sort((a,b) => b.createdAt - a.createdAt).map(view)
}
export async function getHlsTask(gid: string): Promise<DownloadTask> {
  await init()
  const job = jobs.get(gid)
  if (!job || job.status === 'removed') return fail('hls_missing', 'HLS 任务不存在', 404)
  return view(job)
}
export async function pauseHls(gid: string) {
  await init()
  const job = jobs.get(gid)
  if (!job || !['active', 'waiting'].includes(job.status)) return fail('hls_invalid_action', '只能暂停等待中或正在下载的 HLS 任务', 409)
  job.status = 'paused'
  controllers.get(gid)?.abort()
  await persist()
  return { gid }
}
export async function resumeHls(gid: string) {
  await init()
  const job = jobs.get(gid)
  if (!job || job.status !== 'paused') return fail('hls_invalid_action', '仅允许恢复已暂停的 HLS 任务', 409)
  // First release resumes by re-fetching VOD from beginning to avoid partial corrupt output.
  job.status = 'waiting'
  job.progress = 0
  job.completedSegments = 0
  job.completedLength = 0
  job.error = undefined
  await persist()
  queue.push(gid)
  void pump()
  return { gid }
}
export async function removeHls(gid: string, options: { deleteFile?: boolean } = {}) {
  await init()
  const job = jobs.get(gid)
  if (!job) return fail('hls_missing', 'HLS 任务不存在', 404)
  job.status = 'removed'
  controllers.get(gid)?.abort()
  if (options.deleteFile && job.filePath) {
    // Validated file is inside the download root and is a regular file.
    const file = await openSafeDownloadFile(await rootDir(), job.filePath)
    await file.handle.close()
    await rm(file.absolutePath)
  }
  await persist()
  return { gid }
}
export async function openHlsCompletedFile(gid: string) {
  await init()
  const job = jobs.get(gid)
  if (!job || job.status !== 'complete' || !job.filePath) return fail('hls_not_complete', 'HLS 任务尚未完成', 409)
  return openSafeDownloadFile(await rootDir(), job.filePath)
}
