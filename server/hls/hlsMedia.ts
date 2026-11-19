import { createDecipheriv } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '../http.js'
import { hlsIv, type HlsPlaylist, type HlsResource } from './hlsParser.js'
import { readHlsResource } from './hlsNetwork.js'

export interface HlsProgress { completedSegments: number; completedLength: number }

/** Materialize only parsed resources. Never pass source text or remote URLs to FFmpeg. */
export async function stageHlsPlaylist(
  manifest: HlsPlaylist, directory: string, referer: string, signal: AbortSignal,
  onProgress: (progress: HlsProgress) => Promise<void> = async () => {},
  readResource: typeof readHlsResource = readHlsResource
): Promise<string> {
  const keys = new Map<string, Buffer>()
  const maps = new Map<string, string>()
  let total = 0
  const checkAbort = () => {
    if (signal.aborted) throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
  }
  async function fetch(resource: HlsResource, sequence: number): Promise<Buffer> {
    checkAbort()
    let buffer = (await readResource(resource.url, 32 * 1024 * 1024, signal, referer, resource.byteRange)).data
    total += buffer.length
    if (total > 4 * 1024 * 1024 * 1024) throw new AppError('hls_size_limit', 'HLS 下载超过 4GiB 上限', 413)
    if (resource.keyUrl) {
      let key = keys.get(resource.keyUrl)
      if (!key) {
        key = (await readResource(resource.keyUrl, 16, signal, referer)).data
        if (key.length !== 16) throw new AppError('hls_invalid_key', 'EXT-X-KEY AES-128 密钥必须为 16 字节', 422)
        keys.set(resource.keyUrl, key)
      }
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
    const data = await fetch(segment, segment.sequence)
    if (segment.map) validateIsoBmff(data, false)
    else if (!validTransportStream(data)) {
      throw new AppError('hls_invalid_segment', '媒体分片不是完整 MPEG-TS 数据；fMP4 需要 EXT-X-MAP', 422)
    }
    const name = 'segment-' + index + (segment.map ? '.m4s' : '.ts')
    await writeFile(path.join(directory, name), data, { flag: 'wx', mode: 0o600 })
    lines.push('#EXTINF:' + segment.duration + ',', name)
    await onProgress({ completedSegments: index + 1, completedLength: total })
  }
  lines.push('#EXT-X-ENDLIST', '')
  checkAbort()
  const local = path.join(directory, 'local.m3u8')
  await writeFile(local, lines.join('\n'), { flag: 'wx', mode: 0o600 })
  return local
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
