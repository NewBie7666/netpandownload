export interface BilibiliRequestProfile {
  userAgent: string
  acceptLanguage: string
  baseReferer: string
}

const stableProfile: BilibiliRequestProfile = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  acceptLanguage: 'zh-CN,zh;q=0.9',
  baseReferer: 'https://www.bilibili.com'
}

export function getBilibiliRequestProfile(): BilibiliRequestProfile {
  return stableProfile
}
