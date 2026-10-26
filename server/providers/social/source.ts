import { AppError } from '../../http.js'
import { socialPageHosts, type SocialPlatform } from '../../../shared/socialLinks.js'
export { extractSocialSource, isSocialInput } from '../../../shared/socialLinks.js'

/** Every redirect hop must remain on this platform, even if its destination is a login page. */
export function normalizeSocialPageUrl(input: string, platform: SocialPlatform): string {
  let url: URL
  try { url = new URL(input) } catch { throw new AppError('social_invalid_url', '分享链接跳转无效', 400) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || input.length > 8192 || !socialPageHosts[platform].includes(url.hostname.toLowerCase())) {
    throw new AppError('social_redirect_forbidden', '分享链接跳转到非受信任地址，已拒绝访问', 403)
  }
  url.hash = ''
  return url.toString()
}
