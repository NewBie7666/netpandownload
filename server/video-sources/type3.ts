import type { VideoSource } from '../../shared/videoSources.js'
import { AppError } from '../http.js'
import { invokeJavaScriptSource } from './type3-js.js'
import { invokeJavaSource } from './type3-java.js'

export type Type3Action = 'home' | 'search' | 'detail' | 'play'
export interface Type3Arguments { keyword?: string; page?: number; id?: string; flag?: string }
type BrowserResolver = (url: string, headers: Record<string, string>) => Promise<{ url: string; headers: Record<string, string>; kind?: 'hls' | 'mp4' }>
let browserResolver: BrowserResolver | undefined
export function configureType3BrowserResolver(resolver: BrowserResolver) { browserResolver = resolver }
export async function resolveType3WebMedia(url: string, headers: Record<string, string>) {
  if (!browserResolver) throw new AppError('type3_web_parse_required', '该线路需要桌面客户端的网页解析功能', 422)
  try { return await browserResolver(url, headers) }
  catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('type3_web_parse_failed', error instanceof Error ? error.message.slice(0, 600) : '网页解析失败', 502)
  }
}

export async function invokeType3(source: VideoSource, action: Type3Action, args: Type3Arguments = {}): Promise<Record<string, unknown>> {
  let result: unknown
  try {
    result = source.runtime === 'javascript'
      ? await invokeJavaScriptSource(source, action, args)
      : await invokeJavaSource(source, action, args)
  } catch (error) {
    if (error instanceof AppError) throw error
    const failure = error as { code?: unknown; message?: unknown }
    throw new AppError(typeof failure.code === 'string' ? failure.code : 'type3_execution_failed',
      typeof failure.message === 'string' ? failure.message.slice(0, 1500) : 'Type3 执行失败', 502)
  }
  if (typeof result === 'string') {
    try { result = JSON.parse(result) }
    catch { throw new AppError('type3_invalid_result', 'Type3 解析器返回了无效 JSON', 502) }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AppError('type3_invalid_result', 'Type3 解析器没有返回结果对象', 502)
  }
  const object = result as Record<string, unknown>
  if (Number(object.code) < 0) throw new AppError('type3_execution_failed', String(object.msg || object.message || 'Type3 执行失败').slice(0, 400), 502)
  return object
}
