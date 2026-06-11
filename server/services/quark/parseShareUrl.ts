import { AppError } from '../../http.js'

export function parseQuarkShareUrl(shareUrl: string) {
  const value = String(shareUrl || '').trim()
  if (!value) {
    throw new AppError('empty_share_url', '请输入夸克分享链接')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError('invalid_share_url', '分享链接格式不正确')
  }

  if (!/pan\.quark\.cn$/i.test(url.hostname)) {
    throw new AppError('unsupported_share_url', '仅支持夸克网盘分享链接')
  }

  const shareId = url.pathname.match(/\/s\/([^/?#]+)/)?.[1] || ''
  if (!shareId) {
    throw new AppError('invalid_share_url', '未识别到夸克分享 ID')
  }

  return {
    shareId,
    passcode: url.searchParams.get('pwd') || url.searchParams.get('passcode') || ''
  }
}
