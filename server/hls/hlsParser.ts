import { AppError } from '../http.js'

const MAX_RANGE_LENGTH = 32 * 1024 * 1024
const MAX_SEGMENTS = 2000
const MAX_DURATION_SECONDS = 8 * 60 * 60

export interface HlsByteRange {
  offset: number
  length: number
}

export interface HlsResource {
  url: string
  byteRange?: HlsByteRange
  keyUrl?: string
  iv?: string
}

export interface HlsSegment extends HlsResource {
  sequence: number
  duration: number
  discontinuity: boolean
  map?: HlsResource
}

/**
 * `tags` contains the unique EXT tag names encountered in source order. The
 * leading `#` is retained and values after `:` are intentionally omitted.
 */
export interface HlsPlaylist {
  segments: HlsSegment[]
  duration: number
  tags: string[]
}

function fail(message: string): never {
  throw new AppError('hls_playlist_unsupported', message, 422)
}

function unsupportedTag(tag: string, reason = '此标签当前不支持'): never {
  return fail(`不支持 HLS 标签 ${tag}：${reason}`)
}

function mediaUrl(value: string, base: string): string {
  try {
    const url = new URL(value.trim(), base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      fail('分片/密钥/初始化片段 URL 必须为 HTTP/HTTPS')
    }
    return url.toString()
  } catch {
    return fail('无效的 HLS 分片、密钥或初始化片段 URL')
  }
}

function attributes(line: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const colon = line.indexOf(':')
  if (colon < 0) return attrs
  const body = line.slice(colon + 1)
  // HLS attribute values are either quoted or terminate at the next comma.
  // URI values used by this parser do not contain unescaped commas.
  const matcher = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g
  for (const match of body.matchAll(matcher)) {
    attrs.set(match[1], match[2].replace(/^"|"$/g, ''))
  }
  return attrs
}

function tagName(line: string): string | undefined {
  if (!line.startsWith('#EXT')) return undefined
  return /^#EXT(?:[A-Z0-9-]*)/.exec(line)?.[0]
}

function parseSafeInteger(value: string, label: string, options: { min?: number, max?: number } = {}): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value.trim())) fail(`${label}必须是十进制整数`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < (options.min ?? 0) ||
      (options.max !== undefined && parsed > options.max)) {
    fail(`${label}超出安全整数范围`)
  }
  return parsed
}

function parseByteRange(value: string, label: string, explicitOffsetRequired: boolean): HlsByteRange {
  const trimmed = value.trim()
  const match = /^(0|[1-9][0-9]*)(?:@(0|[1-9][0-9]*))?$/.exec(trimmed)
  if (!match) fail(`${label}格式无效，应为 length 或 length@offset`)
  const length = parseSafeInteger(match[1], `${label} length`, { min: 1, max: MAX_RANGE_LENGTH })
  if (explicitOffsetRequired && !match[2]) {
    fail(`${label}必须提供显式 offset，不能使用隐式范围`)
  }
  const offset = match[2] === undefined ? -1 : parseSafeInteger(match[2], `${label} offset`)
  if (offset >= 0 && offset > Number.MAX_SAFE_INTEGER - length) {
    fail(`${label}超出安全整数范围`)
  }
  return { length, offset }
}

function copyResource(resource: HlsResource): HlsResource {
  return resource.byteRange ? { ...resource, byteRange: { ...resource.byteRange } } : { ...resource }
}

/** Return a master variant URL, or null if the text is a media playlist. */
export function selectHlsVariant(text: string, base: string): string | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') fail('不是合法的 HLS 播放列表')

  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue
    const attr = attributes(line)
    const type = attr.get('TYPE')?.toUpperCase()
    if (attr.get('URI') && (type === 'AUDIO' || type === 'VIDEO')) {
      unsupportedTag('#EXT-X-MEDIA', `包含外置${type === 'AUDIO' ? '音轨' : '视频'}，无法在单文件输出中合并`)
    }
  }

  const variants: Array<{ bandwidth: number, url: string }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue
    const attr = attributes(lines[i])
    const next = lines[i + 1]
    if (!next || next.startsWith('#')) fail('HLS 主清单缺少清晰度链接')
    const bandwidthValue = attr.get('BANDWIDTH') || '0'
    const bandwidth = Number(bandwidthValue)
    if (!Number.isFinite(bandwidth) || bandwidth < 0) fail('HLS 清晰度带宽值无效')
    variants.push({ bandwidth, url: mediaUrl(next, base) })
  }
  if (!variants.length) return null
  if (variants.length > 20) fail('HLS 主清单清晰度过多')
  variants.sort((a, b) => b.bandwidth - a.bandwidth)
  return variants[0].url
}

const unsupportedMediaTags = new Map<string, string>([
  ['#EXT-X-PART', '低延迟分片'],
  ['#EXT-X-PART-INF', '低延迟分片信息'],
  ['#EXT-X-PRELOAD-HINT', '低延迟预加载'],
  ['#EXT-X-SERVER-CONTROL', '低延迟服务控制'],
  ['#EXT-X-SKIP', '增量跳过'],
  ['#EXT-X-RENDITION-REPORT', '低延迟渲染报告'],
  ['#EXT-X-I-FRAMES-ONLY', 'I-帧索引清单'],
  ['#EXT-X-GAP', '缺失媒体分片']
])

/**
 * Parse a finished media playlist. MPEG-TS segments and the common VOD
 * fragmented-MP4 form (`EXT-X-MAP`) are represented as local resources for
 * the downloader. HTTP and file safety checks remain in hlsNetwork.ts.
 */
export function parseHlsMediaPlaylist(text: string, base: string): HlsPlaylist {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') fail('不是合法的 HLS 播放列表')

  const tags: string[] = []
  const seenTags = new Set<string>()
  const rememberTag = (line: string) => {
    const name = tagName(line)
    if (name && !seenTags.has(name)) {
      seenTags.add(name)
      tags.push(name)
    }
  }
  for (const line of lines) rememberTag(line)

  if (!lines.includes('#EXT-X-ENDLIST')) fail('首版仅支持已结束的 VOD 清单，不支持直播或持续更新流')
  for (const line of lines) {
    const name = tagName(line)
    const reason = name ? unsupportedMediaTags.get(name) : undefined
    if (name && reason) unsupportedTag(name, reason)
  }

  const seqLine = lines.find(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
  const sequenceStart = parseSafeInteger(seqLine ? seqLine.slice('#EXT-X-MEDIA-SEQUENCE:'.length) : '0', 'HLS 序号')
  const result: HlsSegment[] = []
  let keyUrl: string | undefined
  let iv: string | undefined
  let duration = 0
  let waitingDuration: number | null = null
  let pendingByteRange: HlsByteRange | undefined
  let pendingDiscontinuity = false
  let currentMap: HlsResource | undefined
  let previousSegmentUrl: string | undefined
  let previousSegmentRange: HlsByteRange | undefined

  for (const line of lines) {
    if (line === '#EXTM3U' || line === '#EXT-X-ENDLIST') continue

    if (line.startsWith('#EXT-X-KEY:')) {
      const attr = attributes(line)
      const method = attr.get('METHOD')?.toUpperCase()
      if (!method) fail('EXT-X-KEY 缺少 METHOD')
      if (method === 'NONE') {
        keyUrl = undefined
        iv = undefined
        continue
      }
      if (method !== 'AES-128' || (attr.has('KEYFORMAT') && attr.get('KEYFORMAT') !== 'identity') ||
          (attr.has('KEYFORMATVERSIONS') && attr.get('KEYFORMATVERSIONS') !== '1')) {
        unsupportedTag('#EXT-X-KEY', '仅支持 AES-128 identity 密钥')
      }
      if (!attr.get('URI')) fail('EXT-X-KEY 缺少密钥 URI')
      keyUrl = mediaUrl(attr.get('URI')!, base)
      iv = attr.get('IV')
      if (iv && !/^0x[0-9a-f]{32}$/i.test(iv)) fail('AES-128 IV 必须是 16 字节十六进制')
      continue
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attr = attributes(line)
      if (!attr.get('URI')) fail('EXT-X-MAP 缺少初始化片段 URI')
      let byteRange: HlsByteRange | undefined
      if (attr.has('BYTERANGE')) {
        byteRange = parseByteRange(attr.get('BYTERANGE')!, 'EXT-X-MAP BYTERANGE', true)
      }
      currentMap = {
        url: mediaUrl(attr.get('URI')!, base),
        ...(byteRange ? { byteRange } : {}),
        ...(keyUrl ? { keyUrl } : {}),
        ...(iv ? { iv } : {})
      }
      // An encrypted initialization section has no media sequence from which
      // to derive an IV; HLS requires an explicit IV for this case.
      if (keyUrl && !iv) fail('EXT-X-MAP 使用 AES-128 时必须在 EXT-X-KEY 提供显式 IV')
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (pendingByteRange) fail('重复的 EXT-X-BYTERANGE，前一个范围尚未绑定分片')
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), 'EXT-X-BYTERANGE', false)
      continue
    }

    if (line === '#EXT-X-DISCONTINUITY') {
      pendingDiscontinuity = true
      continue
    }

    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      parseSafeInteger(line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length), 'HLS 不连续序号')
      continue
    }

    if (line.startsWith('#EXTINF:')) {
      if (waitingDuration !== null) fail('HLS 分片缺少 URI')
      const secs = Number(line.slice('#EXTINF:'.length).split(',')[0])
      if (!Number.isFinite(secs) || secs <= 0 || secs > 180) fail('HLS 分片时长无效')
      waitingDuration = secs
      continue
    }

    if (line.startsWith('#')) continue
    if (waitingDuration === null) fail('HLS 分片缺少 EXTINF')

    const url = mediaUrl(line, base)
    let byteRange: HlsByteRange | undefined
    if (pendingByteRange) {
      byteRange = { ...pendingByteRange }
      if (byteRange.offset < 0) {
        if (previousSegmentUrl !== url || !previousSegmentRange) {
          fail('EXT-X-BYTERANGE 缺少 offset，且前一个同 URL 分片没有可推导的范围')
        }
        const nextOffset = previousSegmentRange.offset + previousSegmentRange.length
        if (!Number.isSafeInteger(nextOffset) || nextOffset > Number.MAX_SAFE_INTEGER - byteRange.length) {
          fail('EXT-X-BYTERANGE 隐式范围超出安全整数范围')
        }
        byteRange.offset = nextOffset
      }
      pendingByteRange = undefined
    }

    const isFmp4 = /\.(?:m4s|mp4)(?:[?#]|$)/i.test(url)
    if (isFmp4 && !currentMap) fail('检测到 fMP4 分片，但缺少 EXT-X-MAP 初始化片段')
    if (sequenceStart > Number.MAX_SAFE_INTEGER - result.length) fail('HLS 序号超出安全整数范围')
    const segment: HlsSegment = {
      url,
      ...(byteRange ? { byteRange } : {}),
      ...(keyUrl ? { keyUrl } : {}),
      ...(iv ? { iv } : {}),
      sequence: sequenceStart + result.length,
      duration: waitingDuration,
      discontinuity: pendingDiscontinuity,
      ...(currentMap ? { map: copyResource(currentMap) } : {})
    }
    result.push(segment)
    duration += waitingDuration
    waitingDuration = null
    pendingDiscontinuity = false
    previousSegmentUrl = url
    previousSegmentRange = byteRange
    if (result.length > MAX_SEGMENTS) fail(`HLS 分片超过 ${MAX_SEGMENTS} 个限制`)
    if (duration > MAX_DURATION_SECONDS) fail('HLS 时长超过 8 小时限制')
  }

  if (waitingDuration !== null) fail('HLS 播放列表没有完整的分片')
  if (pendingByteRange) fail('EXT-X-BYTERANGE 后缺少媒体分片 URI')
  if (!result.length) fail('HLS 播放列表没有完整的分片')
  return { segments: result, duration, tags }
}

export function hlsIv(segment: Pick<HlsSegment, 'sequence' | 'iv'>): Buffer {
  if (segment.iv) return Buffer.from(segment.iv.slice(2), 'hex')
  const buffer = Buffer.alloc(16)
  buffer.writeBigUInt64BE(BigInt(segment.sequence), 8)
  return buffer
}
