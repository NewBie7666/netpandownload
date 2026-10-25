import type { QuarkFile } from '../../../shared/types.js'
import { AppError } from '../../http.js'
import { socialMediaDomains } from './mediaPolicy.js'
import type { SocialMedia, SocialPlatform } from './types.js'

const MAX_HTML_BYTES = 8 * 1024 * 1024
const MAX_MEDIA_ITEMS = 50
const MAX_JSON_NODES = 10_000
const MAX_JSON_DEPTH = 256
const MAX_ROOTS = 64

const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm'])
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

type JsonObject = Record<string, unknown>
type MediaKind = 'image' | 'video'

interface MediaCandidate {
  url: string
  extension: string
  size: number
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseFailure(platform?: SocialPlatform): never {
  const name = platform === 'douyin' ? '抖音' : platform === 'xiaohongshu' ? '小红书' : '社交平台'
  throw new AppError('social_parse_failed', `${name}未解析出可用的媒体，内容可能需要登录、已删除或受到平台限制`, 400)
}

function mediaLimitFailure(): never {
  throw new AppError('social_parse_failed', '单帖媒体数量超过安全上限', 400)
}

function assertPlatform(platform: SocialPlatform): void {
  if (platform !== 'douyin' && platform !== 'xiaohongshu') parseFailure()
}

function isAllowedHost(hostname: string, platform: SocialPlatform): boolean {
  const host = hostname.toLowerCase()
  const suffixes = socialMediaDomains[platform]
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

function hasExplicitPort(value: string): boolean {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1] || ''
  if (!authority) return false
  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  // IPv6 literals and every explicit colon are rejected. URL normalises :80/:443
  // away, so checking URL.port alone would miss those ports.
  return hostPort.startsWith('[') || hostPort.includes(':')
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') ||
    host === '0.0.0.0' || host === '::1' || /^127\./.test(host) ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[0-1])\./.test(host)
}

function mediaExtension(value: URL, kind: MediaKind, preferred?: string): string | undefined {
  const fromPreferred = preferred?.toLowerCase().replace(/^\./, '')
  const pathnameExtension = /\.([a-z0-9]{2,8})$/i.exec(value.pathname)?.[1]?.toLowerCase()
  const queryExtension = ['format', 'ext', 'extension', 'image_format', 'mime_type', 'mime']
    .map((key) => value.searchParams.get(key) || '')
    .map((item) => item.toLowerCase().replace(/^\./, '').split('/').pop() || '')
    .find((item) => SUPPORTED_EXTENSIONS.has(item))
  const extension = pathnameExtension && SUPPORTED_EXTENSIONS.has(pathnameExtension)
      ? pathnameExtension
      : fromPreferred && SUPPORTED_EXTENSIONS.has(fromPreferred)
        ? fromPreferred
      : queryExtension

  const lowerPath = `${value.pathname} ${value.search}`.toLowerCase()
  if (/(?:\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])|m3u8|mpegurl|dash(?:[_-]|$))/.test(lowerPath)) return undefined

  if (kind === 'video') {
    if (extension && !VIDEO_EXTENSIONS.has(extension)) return undefined
    return extension || 'mp4'
  }
  if (extension && !IMAGE_EXTENSIONS.has(extension)) return undefined
  return extension || 'jpg'
}

function safeMediaUrl(
  raw: unknown,
  platform: SocialPlatform,
  kind: MediaKind,
  preferredExtension?: string,
  size = 0
): MediaCandidate | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 16_384) return undefined
  const candidate = raw.trim()
  if (!candidate || candidate !== raw || hasExplicitPort(candidate)) return undefined
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port ||
      isLocalHost(parsed.hostname) || !isAllowedHost(parsed.hostname, platform)) return undefined
  const extension = mediaExtension(parsed, kind, preferredExtension)
  if (!extension) return undefined
  const url = parsed.protocol === 'http:' ? `https:${candidate.slice(candidate.indexOf(':') + 1)}` : candidate
  return {
    url,
    extension,
    size: Number.isFinite(size) && size > 0 ? size : 0
  }
}

function countJsonNodes(value: unknown): void {
  const pending: unknown[] = [value]
  let count = 0
  while (pending.length) {
    const current = pending.pop()
    if (!isRecord(current) && !Array.isArray(current)) continue
    count += 1
    if (count > MAX_JSON_NODES) throw new Error('json node limit')
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child)
    } else {
      for (const child of Object.values(current)) pending.push(child)
    }
  }
}

function assertJsonDepth(input: string): void {
  let depth = 0
  let inString = false
  let escaped = false
  for (const char of input) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      if (depth > MAX_JSON_DEPTH) throw new Error('json depth limit')
    } else if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1)
    }
  }
}

/** Replace only bare undefined tokens; quoted strings containing the word are unchanged. */
function replaceBareUndefined(input: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length;) {
    const char = input[index]
    if (inString) {
      output += char
      index += 1
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      index += 1
      continue
    }
    if (input.startsWith('undefined', index)) {
      const previous = index === 0 ? '' : input[index - 1]
      const next = input[index + 'undefined'.length] || ''
      if (!/[A-Za-z0-9_$]/.test(previous) && !/[A-Za-z0-9_$]/.test(next)) {
        output += 'null'
        index += 'undefined'.length
        continue
      }
    }
    output += char
    index += 1
  }
  return output
}

function parseJson(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_HTML_BYTES) throw new Error('json size limit')
  const normalized = replaceBareUndefined(raw.trim().replace(/^\uFEFF/, ''))
  assertJsonDepth(normalized)
  const value = JSON.parse(normalized) as unknown
  countJsonNodes(value)
  return value
}

function decodeUriCandidate(raw: string): string | undefined {
  const trimmed = raw.trim()
  // A normal JSON document may contain percent-encoded signed query values.
  // Decode only a document that is itself URI encoded (the RENDER_DATA form).
  if (!raw.includes('%') || /^[\[{\"]/.test(trimmed)) return undefined
  try {
    const decoded = decodeURIComponent(raw)
    return decoded === raw ? undefined : decoded
  } catch {
    return undefined
  }
}

function parseCandidate(raw: string, output: unknown[], depth = 0): void {
  if (output.length >= MAX_ROOTS || depth > 2) return
  const text = raw.trim()
  if (!text) return
  const variants = [text]
  const decoded = decodeUriCandidate(text)
  if (decoded) variants.unshift(decoded)
  for (const variant of variants) {
    if (output.length >= MAX_ROOTS) return
    try {
      const parsed = parseJson(variant)
      output.push(parsed)
      if (typeof parsed === 'string') {
        const decodedString = decodeUriCandidate(parsed) || parsed
        if (decodedString !== parsed) parseCandidate(decodedString, output, depth + 1)
        else if (/^[\[{]/.test(parsed.trim())) parseCandidate(parsed, output, depth + 1)
      }
      return
    } catch {
      // Try the next representation. This is deliberately JSON-only; no JS is executed.
    }
  }
}

function extractBalancedLiteral(input: string, start: number): string | undefined {
  let index = start
  while (/\s/.test(input[index] || '')) index += 1
  const first = input[index]
  if (first !== '{' && first !== '[' && first !== '"' && first !== "'") return undefined
  if (first === '"' || first === "'") {
    const quote = first
    let escaped = false
    for (let cursor = index + 1; cursor < input.length; cursor += 1) {
      const char = input[cursor]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) return input.slice(index, cursor + 1)
    }
    return undefined
  }
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let cursor = index; cursor < input.length; cursor += 1) {
    const char = input[cursor]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '['
      if (stack.pop() !== expected) return undefined
      if (!stack.length) return input.slice(index, cursor + 1)
    }
    if (stack.length > MAX_JSON_DEPTH) return undefined
  }
  return undefined
}

function extractRoots(html: string): unknown[] {
  const roots: unknown[] = []
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  for (const match of html.matchAll(scriptPattern)) {
    if (roots.length >= MAX_ROOTS) break
    const attributes = match[1] || ''
    const body = match[2] || ''
    const id = /\bid\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2]?.toLowerCase()
    const type = /\btype\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2]?.toLowerCase() || ''
    if (id === 'render_data' || type.includes('json')) parseCandidate(body, roots)
    extractAssignments(body, roots)
  }
  // Some pages omit script tags around the state. Scanning the original text is
  // still safe because only balanced JSON literals are passed to JSON.parse.
  extractAssignments(html, roots)
  return roots
}

function extractAssignments(input: string, roots: unknown[]): void {
  const assignment = /\b(?:window\.)?(?:_ROUTER_DATA|_SSR_DATA|RENDER_DATA|__INITIAL_STATE__)\s*=/g
  for (const match of input.matchAll(assignment)) {
    if (roots.length >= MAX_ROOTS) break
    const start = (match.index || 0) + match[0].length
    const literal = extractBalancedLiteral(input, start)
    if (literal) parseCandidate(literal, roots)
  }
}

function stringId(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return undefined
}

function collectDouyinRecords(roots: unknown[], id: string): JsonObject[] {
  const records: JsonObject[] = []
  const seen = new Set<JsonObject>()
  const pending: unknown[] = [...roots]
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child)
      continue
    }
    if (!isRecord(value)) continue
    const itemIdMatch = stringId(value.itemId) === id && hasDouyinMediaShape(value)
    if ((stringId(value.aweme_id) === id || itemIdMatch) && !seen.has(value)) {
      seen.add(value)
      records.push(value)
    }
    for (const child of Object.values(value)) pending.push(child)
  }
  return records
}

function hasDouyinMediaShape(value: JsonObject): boolean {
  return ['video', 'images', 'image_list', 'imageList', 'image_post_info', 'play_addr',
    'bit_rate', 'bitRate', 'videoInfoRes', 'item_list', 'aweme_detail', 'videoInfo', 'item', 'data']
    .some((key) => key in value)
}

function hasDeclaredDouyinVideo(value: JsonObject): boolean {
  const awemeType = value.aweme_type ?? value.awemeType
  if (typeof awemeType === 'number' && awemeType === 68) return false
  if (typeof awemeType === 'string' && awemeType === '68') return false
  const video = isRecord(value.video) ? value.video : undefined
  if (!video) return false
  const type = typeof video.type === 'string' ? video.type.toLowerCase() : ''
  if (type === 'normal' || type === 'image' || type === 'photo') return false
  if (type === 'video') return true
  if (awemeType !== undefined && awemeType !== null) return true
  return ['play_addr', 'download_addr', 'playAddr', 'bit_rate', 'bitRate'].some((key) => key in video)
}

function hasMediaShape(value: JsonObject): boolean {
  return 'imageList' in value || 'infoList' in value || 'video' in value ||
    'title' in value || 'desc' in value || 'noteId' in value || 'note_id' in value
}

function collectXhsRecords(roots: unknown[], id: string): JsonObject[] {
  const records: JsonObject[] = []
  const seen = new Set<JsonObject>()
  const add = (value: unknown) => {
    if (!isRecord(value) || seen.has(value)) return
    const noteId = stringId(value.noteId) || stringId(value.note_id)
    if (noteId && noteId !== id) return
    seen.add(value)
    records.push(value)
  }
  const pending: Array<{ value: unknown; key?: string }> = roots.map((value) => ({ value }))
  while (pending.length) {
    const entry = pending.pop()
    if (!entry) continue
    const value = entry.value
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child })
      continue
    }
    if (!isRecord(value)) continue
    const noteMap = value.noteDetailMap
    if (isRecord(noteMap)) {
      const mapped = noteMap[id]
      if (isRecord(mapped)) {
        const note = isRecord(mapped.note) ? mapped.note : mapped
        add(note)
      }
    }
    if (entry.key === id && hasMediaShape(value) && !('note' in value)) add(value)
    if (stringId(value.noteId) === id || stringId(value.note_id) === id ||
        (stringId(value.id) === id && hasMediaShape(value))) add(value)
    for (const [key, child] of Object.entries(value)) pending.push({ value: child, key })
  }
  return records
}

function allRecordUrls(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!isRecord(value)) return []
  const urls: string[] = []
  const list = value.url_list ?? value.urlList ?? value.urls
  if (Array.isArray(list)) urls.push(...list.filter((item): item is string => typeof item === 'string'))
  if (typeof value.url === 'string') urls.push(value.url)
  return urls
}

function addUnique(target: MediaCandidate[], candidate: MediaCandidate | undefined): void {
  if (!candidate || target.some((item) => item.url === candidate.url)) return
  target.push(candidate)
}

function collectDouyinMedia(records: JsonObject[], platform: SocialPlatform): MediaCandidate[] {
  const videos: MediaCandidate[] = []
  const images: MediaCandidate[] = []
  const imageObjects: unknown[] = []
  let hasVideoShape = records.some((record) => hasDeclaredDouyinVideo(record))
  const visited = new Set<unknown>()

  const collectVideoAddress = (value: unknown) => {
    for (const url of allRecordUrls(value)) addUnique(videos, safeMediaUrl(url, platform, 'video'))
  }
  const collectImages = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) imageObjects.push(item)
      return
    }
    imageObjects.push(value)
  }

  const walk = (value: unknown, allowImages: boolean) => {
    if (visited.has(value)) return
    if (Array.isArray(value)) {
      visited.add(value)
      for (const child of value) walk(child, allowImages)
      return
    }
    if (!isRecord(value)) return
    visited.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (key === 'play_addr' || key === 'download_addr' || key === 'playAddr') {
        hasVideoShape = true
        collectVideoAddress(child)
      }
      else if (key === 'bit_rate' || key === 'bitRate') {
        hasVideoShape = true
        if (Array.isArray(child)) for (const item of child) {
          if (isRecord(item)) collectVideoAddress(item.play_addr ?? item.playAddr ?? item.download_addr)
        }
      } else if (key === 'images' || key === 'image_list' || key === 'imageList') {
        if (allowImages) collectImages(child)
      } else if (key === 'video' || key === 'image_post_info' || key === 'aweme_detail' || key === 'videoInfoRes' ||
          key === 'item_list' || key === 'videoInfo' || key === 'item' || key === 'data') {
        walk(child, allowImages)
      }
    }
  }

  for (const record of records) walk(record, true)
  for (const item of imageObjects) {
    const urls = allRecordUrls(item)
    const image = urls.map((url) => safeMediaUrl(url, platform, 'image')).find(Boolean)
    addUnique(images, image)
  }
  // For a video post, cover images are intentionally omitted. A carousel with
  // no usable video still returns every safe image in source order.
  if (videos.length || hasVideoShape) return videos.length ? [videos[0]] : []
  if (images.length > MAX_MEDIA_ITEMS) mediaLimitFailure()
  return images
}

function collectXhsVideo(note: JsonObject, platform: SocialPlatform): MediaCandidate[] {
  const video = isRecord(note.video) ? note.video : undefined
  if (!video) return []
  const media = isRecord(video.media) ? video.media : undefined
  const stream = media?.stream
  const firstStreamCandidate = (value: unknown): MediaCandidate | undefined => {
    if (Array.isArray(value)) {
      for (const child of value) {
        const candidate = firstStreamCandidate(child)
        if (candidate) return candidate
      }
      return undefined
    }
    if (!isRecord(value)) return undefined
    for (const key of ['masterUrl', 'master_url', 'backupUrls', 'backup_urls']) {
      const child = value[key]
      if (Array.isArray(child)) {
        for (const url of child) {
          if (typeof url !== 'string') continue
          const candidate = safeMediaUrl(url, platform, 'video')
          if (candidate) return candidate
        }
      } else if (typeof child === 'string') {
        const candidate = safeMediaUrl(child, platform, 'video')
        if (candidate) return candidate
      }
    }
    return undefined
  }
  const streamCandidate = isRecord(stream)
    ? firstStreamCandidate(stream.h264) || firstStreamCandidate(stream.h265) || firstStreamCandidate(stream)
    : firstStreamCandidate(stream)
  if (streamCandidate) return [streamCandidate]

  const consumer = isRecord(video.consumer) ? video.consumer : undefined
  const originKey = consumer?.originVideoKey
  if (typeof originKey === 'string' && originKey) {
    const originUrl = /^https?:\/\//i.test(originKey)
      ? originKey
      : !originKey.startsWith('/') && !originKey.startsWith('//') &&
        !originKey.includes('..') && /^[A-Za-z0-9._~:/?&=%+-]+$/.test(originKey)
        ? `https://sns-video-bd.xhscdn.com/${originKey}`
        : undefined
    const originCandidate = safeMediaUrl(originUrl, platform, 'video')
    if (originCandidate) return [originCandidate]
  }
  return []
}

function collectXhsImageEntries(note: JsonObject): unknown[] {
  if (Array.isArray(note.imageList) && note.imageList.length) return note.imageList
  if (Array.isArray(note.infoList) && note.infoList.length) return note.infoList
  return []
}

function collectXhsImage(entry: unknown, platform: SocialPlatform): MediaCandidate | undefined {
  if (typeof entry === 'string') return safeMediaUrl(entry, platform, 'image')
  if (!isRecord(entry)) return undefined
  for (const key of ['imageSceneWB_DFT', 'urlDefault', 'urlPre']) {
    const value = entry[key]
    const urls = typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : allRecordUrls(value)
    for (const url of urls) {
      const result = safeMediaUrl(url, platform, 'image')
      if (result) return result
    }
  }
  if (Array.isArray(entry.infoList)) {
    for (const child of entry.infoList) {
      const result = collectXhsImage(child, platform)
      if (result) return result
    }
  } else if (isRecord(entry.infoList)) {
    const result = collectXhsImage(entry.infoList, platform)
    if (result) return result
  }
  return undefined
}

function hasDeclaredXhsVideo(value: JsonObject): boolean {
  if (typeof value.type === 'string' && value.type.toLowerCase() === 'video') return true
  const video = isRecord(value.video) ? value.video : undefined
  if (!video) return false
  const type = typeof video.type === 'string' ? video.type.toLowerCase() : ''
  if (type === 'normal' || type === 'image' || type === 'photo') return false
  if (type === 'video' || type === 'livephoto' || type === 'live_photo') return true
  return 'media' in video || 'consumer' in video || 'stream' in video
}

function collectLivePhoto(entry: unknown, platform: SocialPlatform): MediaCandidate[] {
  if (!isRecord(entry)) return []
  const result: MediaCandidate[] = []
  const keys = ['video', 'livePhoto', 'livephoto', 'videoUrl', 'video_url', 'livePhotoVideo', 'livePhotoUrl']
  for (const key of keys) {
    const value = entry[key]
    for (const url of allRecordUrls(value)) addUnique(result, safeMediaUrl(url, platform, 'video'))
    if (isRecord(value)) {
      for (const url of [value.masterUrl, value.master_url, value.backupUrls, value.backup_urls].flat()) {
        if (typeof url === 'string') addUnique(result, safeMediaUrl(url, platform, 'video'))
      }
    }
  }
  return result
}

function collectXhsMedia(records: JsonObject[], platform: SocialPlatform): MediaCandidate[] {
  const hasVideoShape = records.some((record) => hasDeclaredXhsVideo(record))
  for (const note of records) {
    const videos = collectXhsVideo(note, platform)
    if (videos.length) return videos
  }
  if (hasVideoShape) return []
  const result: MediaCandidate[] = []
  for (const note of records) {
    for (const entry of collectXhsImageEntries(note)) {
      addUnique(result, collectXhsImage(entry, platform))
      for (const video of collectLivePhoto(entry, platform)) addUnique(result, video)
    }
  }
  return result
}

function safeNamePart(id: string): string {
  const part = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100)
  return part || 'item'
}

function toSocialMedia(platform: SocialPlatform, id: string, candidates: MediaCandidate[]): SocialMedia[] {
  if (!candidates.length) parseFailure(platform)
  if (candidates.length > MAX_MEDIA_ITEMS) throw new AppError('social_parse_failed', '单帖媒体数量超过安全上限', 400)
  const safeId = safeNamePart(id)
  return candidates.map((candidate, index) => {
    const ordinal = String(index + 1).padStart(2, '0')
    const file: QuarkFile = {
      fid: `${platform}:${safeId}:${ordinal}`,
      name: `${platform}_${safeId}_${ordinal}.${candidate.extension}`,
      size: candidate.size,
      isDir: false,
      createdAt: ''
    }
    return { file, url: candidate.url }
  })
}

export function parseSocialPostHtml(platform: SocialPlatform, html: string, id: string): SocialMedia[] {
  assertPlatform(platform)
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES || !id) parseFailure(platform)
  const roots = extractRoots(html)
  const records = platform === 'douyin' ? collectDouyinRecords(roots, id) : collectXhsRecords(roots, id)
  const candidates = platform === 'douyin'
    ? collectDouyinMedia(records, platform)
    : collectXhsMedia(records, platform)
  return toSocialMedia(platform, id, candidates)
}

function isProgressiveFormat(format: JsonObject): boolean {
  const videoCodec = typeof format.vcodec === 'string' ? format.vcodec.toLowerCase() : ''
  const audioCodec = typeof format.acodec === 'string' ? format.acodec.toLowerCase() : ''
  if (!videoCodec || !audioCodec || videoCodec === 'none' || audioCodec === 'none') return false
  const protocol = typeof format.protocol === 'string' ? format.protocol.toLowerCase() : ''
  const formatId = typeof format.format_id === 'string' ? format.format_id.toLowerCase() : ''
  if (formatId.includes('+') || protocol.includes('m3u8') || protocol.includes('dash') ||
      protocol.includes('fragment') || format.fragments || format.fragment_base_url) return false
  return true
}

export function parseSocialYtdlpJson(platform: SocialPlatform, json: string, id: string): SocialMedia[] {
  assertPlatform(platform)
  if (!id || typeof json !== 'string') parseFailure(platform)
  let root: unknown
  try {
    root = parseJson(json)
  } catch {
    parseFailure(platform)
  }
  if (!isRecord(root) || stringId(root.id) !== id || root._type === 'playlist' ||
      Array.isArray(root.entries) || root.playlist_count !== undefined) parseFailure(platform)
  const formats: unknown[] = []
  if (Array.isArray(root.requested_downloads)) formats.push(...root.requested_downloads)
  if (Array.isArray(root.formats)) formats.push(...root.formats)
  const candidates: MediaCandidate[] = []
  for (const item of formats) {
    if (!isRecord(item) || !isProgressiveFormat(item) || typeof item.url !== 'string') continue
    const declaredExtension = typeof item.ext === 'string' ? item.ext.toLowerCase().replace(/^\./, '') : undefined
    if (declaredExtension && !VIDEO_EXTENSIONS.has(declaredExtension)) continue
    const candidate = safeMediaUrl(item.url, platform, 'video', declaredExtension,
      typeof item.filesize === 'number' ? item.filesize : typeof item.filesize_approx === 'number' ? item.filesize_approx : 0)
    addUnique(candidates, candidate)
  }
  return toSocialMedia(platform, id, candidates)
}

