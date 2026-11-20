import { createDecipheriv } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../http.js'
import { hlsIv, type HlsPlaylist, type HlsResource } from './hlsParser.js'
import { readHlsResource } from './hlsNetwork.js'

export interface HlsProgress { completedSegments: number; completedLength: number }

const MAX_HLS_BYTES = 4 * 1024 * 1024 * 1024
const MAX_HLS_CONCURRENCY = 12

/** Limit in-flight media buffers to a fixed window to avoid large VOD memory spikes. */
export function getHlsSegmentConcurrency(value: unknown = process.env.NETPAN_HLS_CONCURRENCY): number {
  const number = Number(value === undefined || value === '' ? 6 : value)
  if (!Number.isFinite(number) || !Number.isInteger(number)) return 6
  return Math.max(1, Math.min(MAX_HLS_CONCURRENCY, number))
}

function retryableHlsFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    if (error.error === 'hls_timeout') return true
    return error.error === 'hls_http_error' && /HTTP (?:429|50[0-9])\b/.test(error.message)
  }
  const code = (error as NodeJS.ErrnoException | null)?.code
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED'].includes(String(code || ''))
}

type SegmentOutcome = { ok: true; data: Buffer } | { ok: false; error: unknown }

/**
 * Concurrent, bounded prefetch for video segments; local playlist assembly is
 * strictly in source order. AES keys and fMP4 maps retain their existing
 * verification and decryption checks. Any rejected segment cancels siblings.
 */
export async function stageHlsPlaylist(
  manifest: HlsPlaylist, directory: string, referer: string, signal: AbortSignal,
  onProgress: (progress: HlsProgress) => Promise<void> = async () => {},
  readResource: typeof readHlsResource = readHlsResource,
  requestedConcurrency: number = getHlsSegmentConcurrency()
): Promise<string> {
  const concurrency = getHlsSegmentConcurrency(requestedConcurrency)
  const keyPromises = new Map<string, Promise<Buffer>>()
  const maps = new Map<string, string>()
  let total = 0
  const workController = new AbortController()
  const onAbort = () => workController.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) workController.abort()

  const checkAbort = () => {
    if (workController.signal.aborted) throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
  }
  async function readWithRetry(resource: HlsResource, limit: number): Promise<Buffer> {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkAbort()
      try {
        const response = await readResource(resource.url, limit, workController.signal, referer, resource.byteRange)
        checkAbort()
        return response.data
      } catch (error) {
        checkAbort()
        if (attempt === 2 || !retryableHlsFailure(error)) throw error
        try {
          await sleep(attempt === 0 ? 250 : 750, undefined, { signal: workController.signal })
        } catch {
          checkAbort()
          throw error
        }
      }
    }
    throw new AppError('hls_network_failed', 'HLS 分片下载重试失败', 502)
  }
  async function keyFor(url: string): Promise<Buffer> {
    let pending = keyPromises.get(url)
    if (!pending) {
      pending = readWithRetry({ url }, 16).then(data => {
        if (data.length !== 16) throw new AppError('hls_invalid_key', 'EXT-X-KEY AES-128 密钥必须为 16 字节', 422)
        return data
      })
      keyPromises.set(url, pending)
    }
    return pending
  }
  async function fetch(resource: HlsResource, sequence: number): Promise<Buffer> {
    checkAbort()
    let buffer = await readWithRetry(resource, 32 * 1024 * 1024)
    total += buffer.length
    if (total > MAX_HLS_BYTES) throw new AppError('hls_size_limit', 'HLS 下载超过 4GiB 上限', 413)
    if (resource.keyUrl) {
      const key = await keyFor(resource.keyUrl)
      try {
        const decoder = createDecipheriv('aes-128-cbc', key, hlsIv({ sequence, iv: resource.iv }))
        buffer = Buffer.concat([decoder.update(buffer), decoder.final()])
      } catch {
        throw new AppError('hls_decryption_failed', 'EXT-X-KEY AES-128 解密失败，请检查密钥或分片完整性', 422)
      }
    }
    checkAbort()
    return buffer
  }

  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...manifest.segments.map(s => s.duration))),
    '#EXT-X-MEDIA-SEQUENCE:0']
  const scheduled = new Map<number, Promise<SegmentOutcome>>()
  let nextToSchedule = 0
  const fillWindow = (nextToConsume: number) => {
    while (nextToSchedule < manifest.segments.length &&
        nextToSchedule < nextToConsume + concurrency) {
      const index = nextToSchedule++
      const segment = manifest.segments[index]
      // Use a fulfilled outcome so future failures do not trigger unhandled
      // promise rejections while awaiting an earlier, slower segment.
      const pending: Promise<SegmentOutcome> = fetch(segment, segment.sequence)
        .then(data => ({ ok: true as const, data }), error => ({ ok: false as const, error }))
      scheduled.set(index, pending)
    }
  }

  try {
    checkAbort()
    fillWindow(0)
    let previousMap: string | undefined
    for (const [index, segment] of manifest.segments.entries()) {
      checkAbort()
      if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
      if (segment.map) {
        const identity = JSON.stringify(segment.map)
        let name = maps.get(identity)
        if (!name) {
          name = 'init-' + maps.size + '.mp4'
          const init = await fetch(segment.map, segment.sequence)
          validateIsoBmff(init, true)
          await writeFile(path.join(directory, name), init, { flag: 'wx', mode: 0o600 })
          maps.set(identity, name)
        }
        if (name !== previousMap) lines.push('#EXT-X-MAP:URI="' + name + '"')
        previousMap = name
      }
      const pending = scheduled.get(index)
      if (!pending) throw new AppError('hls_internal', 'HLS 并发任务缺失', 500)
      const result = await pending
      scheduled.delete(index)
      if (!result.ok) throw result.error
      checkAbort()
      const data = result.data
      if (segment.map) validateIsoBmff(data, false)
      else if (!validTransportStream(data)) {
        throw new AppError('hls_invalid_segment', '媒体分片不是完整 MPEG-TS 数据；fMP4 需要 EXT-X-MAP', 422)
      }
      const name = 'segment-' + index + (segment.map ? '.m4s' : '.ts')
      await writeFile(path.join(directory, name), data, { flag: 'wx', mode: 0o600 })
      lines.push('#EXTINF:' + segment.duration + ',', name)
      await onProgress({ completedSegments: index + 1, completedLength: total })
      fillWindow(index + 1)
    }
    lines.push('#EXT-X-ENDLIST', '')
    checkAbort()
    const local = path.join(directory, 'local.m3u8')
    await writeFile(local, lines.join('\n'), { flag: 'wx', mode: 0o600 })
    return local
  } finally {
    workController.abort()
    signal.removeEventListener('abort', onAbort)
  }
}

function validTransportStream(data: Buffer): boolean {
  if (data.length < 188 || data.length % 188 !== 0) return false
  for (let offset = 0; offset < data.length; offset += 188) {
    if (data[offset] !== 0x47) return false
  }
  return true
}

// Reject HTML, nested manifests and arbitrary formats before invoking a media parser.
function validateIsoBmff(data: Buffer, initialization: boolean): void {
  const types = new Set<string>()
  let offset = 0
  while (offset + 8 <= data.length) {
    let size = data.readUInt32BE(offset)
    const type = data.toString('ascii', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > data.length) break
      const large = data.readBigUInt64BE(offset + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break
      size = Number(large)
      header = 16
    } else if (size === 0) size = data.length - offset
    if (size < header || offset + size > data.length) break
    types.add(type)
    offset += size
  }
  if (offset !== data.length || !(initialization ? types.has('moov') : types.has('moof') && types.has('mdat'))) {
    throw new AppError('hls_invalid_segment', initialization
      ? 'EXT-X-MAP 不是完整 fMP4 初始化片段' : 'fMP4 分片缺少完整 moof/mdat 数据', 422)
  }
}
