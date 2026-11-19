import { AppError } from '../http.js'

const allowedHeaders = new Map([
  ['user-agent', 'User-Agent'], ['referer', 'Referer'], ['origin', 'Origin'],
  ['cookie', 'Cookie'], ['authorization', 'Authorization'], ['accept', 'Accept']
])

export function normalizeMediaHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { throw new AppError('video_headers_invalid', '播放请求头格式无效') }
  }
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new AppError('video_headers_invalid', '播放请求头格式无效')
  const headers: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    const name = allowedHeaders.get(key.toLowerCase())
    if (!name) continue
    if (typeof entry !== 'string' || entry.length > 8192 || /[\r\n\0]/.test(entry)) {
      throw new AppError('video_headers_invalid', '播放请求头包含无效内容')
    }
    headers[name] = entry
  }
  return headers
}
