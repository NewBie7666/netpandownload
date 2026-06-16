import { AppError } from '../../../http.js'
import { classifyFailure } from './failureClassifier.js'

export function toBilibiliFailSafeError(error: unknown, context: 'resolve' | 'media') {
  const failure = classifyFailure(error)
  if (failure.type === 'dependency_missing') {
    return new AppError('ytdlp_unavailable', '未找到 yt-dlp，无法解析 B站资源')
  }
  if (failure.type === 'bilibili_412' || failure.type === 'rate_limited') {
    return new AppError('bilibili_blocked_by_upstream', 'B站返回风控限制，请稍后重试或配置后端 BILIBILI_COOKIE')
  }
  if (failure.type === 'restricted') {
    return new AppError('bilibili_access_restricted', '该 B站资源需要更高登录态或访问权限')
  }
  if (failure.type === 'yt_dlp_timeout') {
    return new AppError(context === 'media' ? 'media_extract_timeout' : 'bilibili_network_error', 'B站解析超时，请稍后重试')
  }
  if (context === 'media') {
    return new AppError('media_resolution_failed', failure.message || 'B站媒体直链解析失败')
  }
  return new AppError('bilibili_network_error', failure.message || 'B站解析失败，请稍后重试')
}
