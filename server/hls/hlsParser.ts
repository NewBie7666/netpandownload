import { AppError } from '../http.js'

export interface HlsSegment {
  url: string
  sequence: number
  keyUrl?: string
  iv?: string
}
export interface HlsPlaylist { segments: HlsSegment[], duration: number }

function fail(message: string): never {
  throw new AppError('hls_playlist_unsupported', message, 422)
}
function mediaUrl(value: string, base: string) {
  try {
    const url = new URL(value.trim(), base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('分片/密钥 URL 必须为 HTTP/HTTPS')
    return url.toString()
  } catch { return fail('无效的 HLS 分片或播放列表 URL') }
}
function attributes(line: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const body = line.slice(line.indexOf(':') + 1)
  const matcher = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g
  for (const match of body.matchAll(matcher)) attrs.set(match[1], match[2].replace(/^"|"$/g, ''))
  return attrs
}

/** Return a master variant URL, or null if the text is a media playlist. */
export function selectHlsVariant(text: string, base: string): string | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') fail('不是合法的 HLS 播放列表')
  if (lines.some(l => /^#EXT-X-MEDIA:TYPE=AUDIO.*URI=/i.test(l))) {
    fail('此清单包含外置音轨，首版不支持分离音轨合并')
  }
  const variants: Array<{ bandwidth: number, url: string }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue
    const attr = attributes(lines[i])
    const next = lines[i + 1]
    if (!next || next.startsWith('#')) fail('HLS 主清单缺少清晰度链接')
    variants.push({ bandwidth: Math.max(0, Number(attr.get('BANDWIDTH') || 0)), url: mediaUrl(next, base) })
  }
  if (!variants.length) return null
  if (variants.length > 20) fail('HLS 主清单清晰度过多')
  variants.sort((a,b) => b.bandwidth - a.bandwidth)
  return variants[0].url
}

/** Restricted VOD MPEG-TS playlist; explicit refusal of live, DRM, byterange, fMP4. */
export function parseHlsMediaPlaylist(text: string, base: string): HlsPlaylist {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') fail('不是合法的 HLS 播放列表')
  if (!lines.includes('#EXT-X-ENDLIST')) fail('首版仅支持已结束的 VOD 清单，不支持直播或持续更新流')
  if (lines.some(l => /^#EXT-X-(MAP|BYTERANGE|PART|PRELOAD-HINT|DISCONTINUITY|I-FRAMES-ONLY|SKIP)/i.test(l))) {
    fail('此 HLS 清单包含 fMP4、字节区间、低延迟或不连续时间戳，暂不支持')
  }
  const seqLine = lines.find(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
  const sequenceStart = Number(seqLine ? seqLine.split(':')[1] : '0')
  if (!Number.isSafeInteger(sequenceStart) || sequenceStart < 0) fail('HLS 序号无效')
  const result: HlsSegment[] = []
  let keyUrl: string | undefined
  let iv: string | undefined
  let duration = 0
  let waitingDuration: number | null = null
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) {
      const attr = attributes(line)
      if (attr.get('METHOD') === 'NONE') { keyUrl = undefined; iv = undefined; continue }
      if (attr.get('METHOD') !== 'AES-128' || (attr.has('KEYFORMAT') && attr.get('KEYFORMAT') !== 'identity')) {
        fail('不支持 DRM、SAMPLE-AES 或非 AES-128 身份密钥')
      }
      if (!attr.get('URI')) fail('AES-128 密钥地址缺失')
      keyUrl = mediaUrl(attr.get('URI')!, base)
      iv = attr.get('IV')
      if (iv && !/^0x[0-9a-f]{32}$/i.test(iv)) fail('AES-128 IV 必须是 16 字节十六进制')
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      const secs = Number(line.slice(8).split(',')[0])
      if (!Number.isFinite(secs) || secs <= 0 || secs > 180) fail('HLS 分片时长无效')
      waitingDuration = secs
      continue
    }
    if (line.startsWith('#')) continue
    if (waitingDuration === null) fail('HLS 分片缺少 EXTINF')
    if (/\.(m4s|mp4)(?:\?|$)/i.test(line)) fail('此清单包含 fMP4 分片，首版只处理 MPEG-TS')
    result.push({ url: mediaUrl(line, base), sequence: sequenceStart + result.length, keyUrl, iv })
    duration += waitingDuration
    waitingDuration = null
    if (result.length > 2000) fail('HLS 分片超过 2000 个限制')
  }
  if (waitingDuration !== null || !result.length) fail('HLS 播放列表没有完整的分片')
  if (duration > 8 * 3600) fail('HLS 时长超过 8 小时限制')
  return { segments: result, duration }
}

export function hlsIv(segment: HlsSegment): Buffer {
  if (segment.iv) return Buffer.from(segment.iv.slice(2), 'hex')
  const buffer = Buffer.alloc(16)
  buffer.writeBigUInt64BE(BigInt(segment.sequence), 8)
  return buffer
}
