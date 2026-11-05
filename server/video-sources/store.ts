import { randomUUID } from 'node:crypto'
import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { VideoSource, VideoSourceImportResult } from '../../shared/videoSources.js'
import { AppError } from '../http.js'
import { fetchVideoSourceJson, validateVideoSourceUrl } from './network.js'

const maxSources = 40
let mutationQueue: Promise<unknown> = Promise.resolve()

function filePath(): string {
  const configured = String(process.env.NETPAN_VIDEO_SOURCE_FILE || '').trim()
  if (configured) return path.resolve(configured)
  if (process.env.NETPAN_PRIVATE_WEB === 'true') {
    return path.resolve(process.env.NETPAN_DOWNLOAD_DIR || '/srv/netpandownload/downloads', '.video-sources.json')
  }
  return path.join(homedir(), '.netpandownload', 'video-sources.json')
}

async function readSources(): Promise<VideoSource[]> {
  let raw: string
  try { raw = await readFile(filePath(), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  try {
    const sources: unknown = JSON.parse(raw)
    if (!Array.isArray(sources) || sources.length > maxSources) throw new Error('Invalid catalog')
    return sources as VideoSource[]
  } catch { throw new AppError('video_sources_corrupted', '影视源配置损坏，请备份并检查配置文件', 500) }
}

async function saveSources(sources: VideoSource[]): Promise<void> {
  const target = filePath()
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temp = target + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temp, JSON.stringify(sources, null, 2), { mode: 0o600, flag: 'wx' })
    await rename(temp, target)
  } finally { await rm(temp, { force: true }).catch(() => undefined) }
}

function synchronized<T>(task: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(task, task)
  mutationQueue = next.then(() => undefined, () => undefined)
  return next
}

export function listVideoSources(): Promise<VideoSource[]> {
  return synchronized(readSources)
}

function normalized(name: unknown, apiUrl: unknown): Pick<VideoSource, 'name' | 'apiUrl'> {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
    throw new AppError('video_source_invalid_name', '影视源名称必须为 1-80 个字符')
  }
  return { name: name.trim(), apiUrl: validateVideoSourceUrl(apiUrl).toString() }
}

export function addVideoSource(input: unknown): Promise<VideoSource> {
  return synchronized(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('video_source_invalid', '影视源参数不正确')
    const data = input as Record<string, unknown>
    if (data.type !== undefined && data.type !== 'maccms') throw new AppError('video_source_type_unsupported', '目前仅支持 MacCMS JSON API')
    const values = normalized(data.name, data.apiUrl)
    const sources = await readSources()
    if (sources.length >= maxSources) throw new AppError('video_sources_full', '最多添加 40 个影视源', 409)
    if (sources.some(item => item.apiUrl === values.apiUrl)) throw new AppError('video_source_duplicate', '该 API 已添加', 409)
    const source: VideoSource = { id: randomUUID(), ...values, enabled: true, type: 'maccms' }
    sources.push(source)
    await saveSources(sources)
    return source
  })
}

export function updateVideoSource(id: string, input: unknown): Promise<VideoSource> {
  return synchronized(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('video_source_invalid', '影视源参数不正确')
    const data = input as Record<string, unknown>
    const sources = await readSources()
    const entry = sources.find(item => item.id === id)
    if (!entry) throw new AppError('video_source_missing', '影视源不存在', 404)
    if (typeof data.enabled !== 'boolean') throw new AppError('video_source_invalid', 'enabled 必须是布尔值')
    entry.enabled = data.enabled
    await saveSources(sources)
    return entry
  })
}

export function removeVideoSource(id: string): Promise<{ id: string }> {
  return synchronized(async () => {
    const sources = await readSources()
    const next = sources.filter(item => item.id !== id)
    if (sources.length === next.length) throw new AppError('video_source_missing', '影视源不存在', 404)
    await saveSources(next)
    return { id }
  })
}

export function importTvBoxSources(value: unknown): Promise<VideoSourceImportResult> {
  return synchronized(async () => {
    let config: unknown = value
    if (typeof config === 'string') {
      if (config.length > 250_000) throw new AppError('video_source_import_large', 'TVBox 配置过大', 413)
      try { config = JSON.parse(config) as unknown }
      catch { throw new AppError('video_source_import_invalid', 'TVBox 内容不是合法 JSON') }
    }
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        !Array.isArray((config as { sites?: unknown }).sites)) {
      throw new AppError('video_source_import_invalid', 'TVBox JSON 缺少 sites 数组')
    }
    const sites = (config as { sites: unknown[] }).sites.slice(0, 200)
    const sources = await readSources()
    let imported = 0
    let skipped = 0
    for (const site of sites) {
      if (!site || typeof site !== 'object' || Array.isArray(site)) { skipped++; continue }
      const entry = site as Record<string, unknown>
      // TVBox Spider, jar, ext scripts and non-MacCMS parsers are intentionally excluded.
      if (entry.type !== 1 && entry.type !== '1') { skipped++; continue }
      try {
        const { name, apiUrl } = normalized(entry.name, entry.api)
        if (sources.some(item => item.apiUrl === apiUrl) || sources.length >= maxSources) {
          skipped++
          continue
        }
        sources.push({ id: randomUUID(), name, apiUrl, enabled: true, type: 'maccms' })
        imported++
      } catch { skipped++ }
    }
    if (imported) await saveSources(sources)
    return { imported, skipped: skipped + Math.max(0, (config as { sites: unknown[] }).sites.length - sites.length), sources }
  })
}

// The user may paste a TVBox *configuration URL*, not only a downloaded JSON body.
// Reuse the pinned-address, redirect-limited, 1.5MB JSON-only network client.
// Fetch outside the mutation lock, then store through the same atomic importer.
export async function importTvBoxSourcesFromUrl(
  input: unknown,
  fetcher: (url: string) => Promise<unknown> = fetchVideoSourceJson
): Promise<VideoSourceImportResult> {
  const url = validateVideoSourceUrl(input).toString()
  const config = await fetcher(url)
  return importTvBoxSources(config)
}
