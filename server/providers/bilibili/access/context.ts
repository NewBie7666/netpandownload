export interface AccessContext {
  url: string
  userAgent: string
  referer: string
  cookies?: string
  retryCount: number
}

export const defaultBilibiliUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

export const defaultBilibiliReferer = 'https://www.bilibili.com'

export function createAccessContext(url: string, retryCount = 0): AccessContext {
  const cookies = String(process.env.BILIBILI_COOKIE || '').trim()
  return {
    url,
    userAgent: defaultBilibiliUserAgent,
    referer: defaultBilibiliReferer,
    cookies: cookies || undefined,
    retryCount
  }
}
