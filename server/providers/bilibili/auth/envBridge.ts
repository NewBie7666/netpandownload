let runtimeCookie = ''

export function isValidBilibiliCookie(cookie: string) {
  return /\bSESSDATA=/.test(cookie) && /\bDedeUserID=/.test(cookie)
}

export function getCookie() {
  const cookie = runtimeCookie || String(process.env.BILIBILI_COOKIE || '').trim()
  return isValidBilibiliCookie(cookie) ? cookie : ''
}

export function setRuntimeCookie(cookie: string) {
  const normalized = String(cookie || '').trim()
  if (!isValidBilibiliCookie(normalized)) {
    clearRuntimeCookie()
    return
  }

  runtimeCookie = normalized
  process.env.BILIBILI_COOKIE = normalized
}

export function clearRuntimeCookie() {
  runtimeCookie = ''
  delete process.env.BILIBILI_COOKIE
}
