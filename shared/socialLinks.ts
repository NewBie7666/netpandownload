export type SocialPlatform = 'douyin' | 'xiaohongshu'
export interface SocialSource { platform: SocialPlatform; url: string; id?: string }

export const socialPageHosts: Record<SocialPlatform, readonly string[]> = {
  douyin: ['douyin.com', 'www.douyin.com', 'm.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'],
  xiaohongshu: ['xiaohongshu.com', 'www.xiaohongshu.com', 'm.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com']
}

/** Accept a single supported post or copied share text; never accept profiles or arbitrary hosts. */
export function extractSocialSource(input: string, expectedPlatform?: SocialPlatform): SocialSource {
  if (typeof input !== 'string' || input.length > 16384) throw new Error('分享文案过长或格式无效')
  const raw = input.trim().replace(/^["']|["']$/g, '')
  const tailSafePath = `[^\\s<>"'，。；：！？、）》】』」]+`
  const bareCandidate = raw.match(new RegExp(`^(?:(?:www|m|v)\\.)?(?:douyin\\.com|iesdouyin\\.com|xiaohongshu\\.com|xhslink\\.com)\\/${tailSafePath}`, 'iu'))?.[0]
  const candidate = bareCandidate
    ? `https://${bareCandidate}`
    : raw.match(new RegExp(`https?:\\/\\/(?:(?:www|m|v)\\.)?(?:douyin\\.com|iesdouyin\\.com|xiaohongshu\\.com|xhslink\\.com)(?:\\/${tailSafePath})?`, 'iu'))?.[0]
  if (!candidate) throw new Error('请粘贴抖音或小红书的单个作品分享链接')
  const url = new URL(candidate.replace(/[.,!?;:\u2026，。；：！？，、）》】』」)\]}>]+$/gu, '').replace(/\s+$/g, ''))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.toString().length > 8192) throw new Error('分享链接包含不允许的协议、凭据或端口')
  const platform = (Object.keys(socialPageHosts) as SocialPlatform[]).find(key => socialPageHosts[key].includes(url.hostname.toLowerCase()))
  if (!platform || (expectedPlatform && platform !== expectedPlatform)) throw new Error('分享链接平台不匹配')
  url.protocol = 'https:'
  url.hash = ''
  let id: string | undefined
  const host = url.hostname.toLowerCase()
  if (platform === 'douyin') {
    if (host === 'v.douyin.com') {
      if (!/^\/[A-Za-z0-9_-]{3,80}\/?$/.test(url.pathname)) throw new Error('无效的抖音分享短链')
    } else if (host === 'douyin.com' || host === 'www.douyin.com' || host === 'm.douyin.com') {
      id = /^\/(?:video|note)\/(\d{10,24})\/?$/i.exec(url.pathname)?.[1]
      if (!id && ['/', '/discover', '/discover/'].includes(url.pathname)) {
        const modal = url.searchParams.get('modal_id') || ''
        if (/^\d{10,24}$/.test(modal)) {
          id = modal
          url.hostname = 'www.douyin.com'
          url.pathname = '/video/' + id
          url.search = ''
        }
      }
      if (!id) throw new Error('只支持抖音单个视频或图文作品，不支持主页和直播')
    } else {
      id = /^\/share\/(?:video|note)\/(\d{10,24})\/?$/i.exec(url.pathname)?.[1]
      if (!id) throw new Error('只支持抖音单个视频或图文作品，不支持主页和直播')
    }
  } else if (host === 'xhslink.com' || host === 'www.xhslink.com') {
    if (!/^\/(?:[A-Za-z]\/)?[A-Za-z0-9_-]{3,100}\/?$/.test(url.pathname)) throw new Error('无效的小红书分享短链')
  } else {
    id = /^\/(?:explore|discovery\/item)\/([0-9a-f]{24})\/?$/i.exec(url.pathname)?.[1]?.toLowerCase()
    if (!id) throw new Error('只支持小红书单篇笔记，不支持用户主页和搜索页')
  }
  return { platform, url: url.toString(), id }
}

export function isSocialInput(input: string, platform: SocialPlatform): boolean {
  try { return extractSocialSource(input, platform).platform === platform } catch { return false }
}
