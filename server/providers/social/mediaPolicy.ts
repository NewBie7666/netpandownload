import type { SocialPlatform } from './types.js'

export const socialMediaDomains: Record<SocialPlatform, readonly string[]> = {
  douyin: ['douyinvod.com', 'douyinpic.com', 'douyincdn.com', 'byteimg.com', 'bytecdn.cn', 'pstatp.com', 'amemv.com'],
  xiaohongshu: ['xhscdn.com', 'xiaohongshu.com']
}
export const socialUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
export function socialPageUserAgent(platform: SocialPlatform): string {
  // Douyin's public mobile share page includes post metadata; the desktop URL
  // may return only an application shell. No page scripts or challenges run.
  return platform === 'douyin'
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    : socialUserAgent
}
export function socialMediaHeaders(url: URL): string[] {
  for (const platform of ['douyin', 'xiaohongshu'] as const) {
    if (socialMediaDomains[platform].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
      const referer = platform === 'douyin' ? 'https://www.douyin.com/' : 'https://www.xiaohongshu.com/'
      return [`Referer: ${referer}`, `User-Agent: ${socialPageUserAgent(platform)}`]
    }
  }
  return []
}
