import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright-core'
import { AppError } from '../../http.js'
import { resolveDouyinBrowserPath } from '../../auth/douyin/browserDriver.js'
import { getDefaultDouyinStore } from '../../auth/douyin/sessionStore.js'
import type { DouyinAuthStore } from '../../auth/douyin/types.js'
import { parseSocialPostHtml } from './metadataParser.js'
import type { SocialMedia, SocialSource } from './types.js'

const MAX_HTML_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 45_000
const DETAIL_PATH = /^\/aweme\/v1\/web\/aweme\/detail\/?$/
const VIDEO_ID = /^\d{6,32}$/
const OFFICIAL_VERIFICATION = /verifycenter\/captcha|captcha\/verify/i
const VERIFICATION_TEXT = /拖动滑块|安全验证|完成验证|请完成验证/i

let activeParse = false

function officialHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'douyin.com' || host.endsWith('.douyin.com') ||
    host === 'bytedance.com' || host.endsWith('.bytedance.com')
}

function allowedNavigation(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && officialHost(url.hostname)
  } catch {
    return false
  }
}

function browserHeadless(): boolean {
  return process.env.NETPAN_DOUYIN_HEADLESS === 'false'
    ? false
    : process.env.NETPAN_DOUYIN_HEADLESS === 'true' || process.env.NETPAN_PRIVATE_WEB === 'true'
}

function verificationRequired() {
  return new AppError('verification_required', '抖音官方页面要求人工完成安全验证，请在登录窗口完成验证后重试', 403)
}

function authRequired() {
  return new AppError('auth_required', '抖音登录态已失效，请重新扫码登录', 401)
}

function browserTimeout() {
  return new AppError('douyin_browser_timeout', '抖音官方页面响应超时，请稍后重试', 504)
}

function isVerificationHost(hostname: string): boolean {
  return officialHost(hostname)
}

async function hasVerification(context: BrowserContext): Promise<boolean> {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      let frameUrl = ''
      try { frameUrl = frame.url() } catch { continue }
      let host = ''
      try { host = new URL(frameUrl).hostname } catch { continue }
      if (!isVerificationHost(host)) continue
      if (OFFICIAL_VERIFICATION.test(frameUrl)) {
        // A hidden captcha iframe is commonly present on the normal login
        // shell. Only treat a challenge iframe as active when it is visible.
        if (frame.parentFrame()) {
          try {
            const element = await frame.frameElement()
            const box = await element.boundingBox()
            if (box && box.width > 40 && box.height > 40 && await element.isVisible()) return true
          } catch { /* frame disappeared or is hidden */ }
        } else {
          return true
        }
      }
      const body = await frame.locator('body').innerText({ timeout: 400 }).catch(() => '')
      if (VERIFICATION_TEXT.test(body) && (/verify|captcha/.test(frameUrl) || !frame.parentFrame())) return true
    }
  }
  return false
}

function assertResponseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'www.douyin.com' && DETAIL_PATH.test(url.pathname)
  } catch {
    return false
  }
}

export interface AuthenticatedDouyinBrowserOptions {
  launchBrowser?: (options: LaunchOptions) => Promise<Browser>
  store?: DouyinAuthStore
  timeoutMs?: number
}

/**
 * Read a single authenticated Douyin detail response in a fresh browser
 * context. This is deliberately separate from the QR login session: it never
 * opens a personal profile and never returns browser or cookie data.
 */
export async function extractAuthenticatedDouyin(
  source: SocialSource,
  options: AuthenticatedDouyinBrowserOptions = {}
): Promise<SocialMedia[] | undefined> {
  if (source.platform !== 'douyin' || !source.id || !VIDEO_ID.test(source.id)) return undefined
  if (activeParse) throw new AppError('douyin_browser_busy', '抖音浏览器解析正在进行，请稍后重试', 429)
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, Math.min(DEFAULT_TIMEOUT_MS, Math.floor(options.timeoutMs as number)))
    : DEFAULT_TIMEOUT_MS
  activeParse = true
  const deadline = Date.now() + timeoutMs
  let deadlineExpired = false
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  let cleanupPromise: Promise<void> | undefined
  const closeResources = () => cleanupPromise ||= (async () => {
    try { await context?.close() } catch { /* cleanup is best effort */ }
    try { await browser?.close({ reason: 'Douyin authenticated extraction ended' }) } catch { /* cleanup is best effort */ }
  })()
  const timeoutHandle = setTimeout(() => {
    deadlineExpired = true
    void closeResources()
  }, timeoutMs)
  const unref = (timeoutHandle as unknown as { unref?: () => void }).unref
  unref?.call(timeoutHandle)
  const remaining = () => Math.max(1, deadline - Date.now())
  const awaitDeadline = async <T>(promise: Promise<T>): Promise<T> => {
    if (Date.now() >= deadline) {
      deadlineExpired = true
      void closeResources()
      throw browserTimeout()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        deadlineExpired = true
        void closeResources()
        reject(browserTimeout())
      }, remaining())
    })
    try {
      return await Promise.race([promise, expiry])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    const store = options.store || getDefaultDouyinStore()
    let state
    try {
      state = await awaitDeadline(Promise.resolve().then(() => store.read()))
    } catch (error) {
      if (deadlineExpired) throw browserTimeout()
      if (error instanceof AppError) throw error
      return undefined
    }
    if (state.status !== 'authenticated' || state.cookies.length === 0) return undefined

    let executablePath: string | undefined
    try {
      executablePath = await awaitDeadline(resolveDouyinBrowserPath())
    } catch (error) {
      if (deadlineExpired) throw browserTimeout()
      throw error
    }
    if (!executablePath) return undefined

    const launchBrowser = options.launchBrowser || ((launchOptions: LaunchOptions) => chromium.launch(launchOptions))
    const launchPromise = Promise.resolve().then(() => launchBrowser({
      executablePath,
      headless: browserHeadless(),
      chromiumSandbox: true,
      timeout: 30_000,
      args: ['--disable-dev-shm-usage', '--mute-audio', '--no-first-run', '--window-size=1100,850']
    }))
    void launchPromise.then(value => {
      if (deadlineExpired) void value.close({ reason: 'Douyin authenticated extraction timed out' }).catch(() => undefined)
      else browser = value
    }, () => undefined)
    browser = await awaitDeadline(launchPromise)
    if (deadlineExpired) throw browserTimeout()

    const contextPromise = browser.newContext({ viewport: { width: 1100, height: 850 }, locale: 'zh-CN', acceptDownloads: false })
    void contextPromise.then(value => { if (deadlineExpired) void value.close().catch(() => undefined) }, () => undefined)
    context = await awaitDeadline(contextPromise)
    await awaitDeadline(context.addCookies(state.cookies))
    await awaitDeadline(context.route('**/*', async route => {
      const request = route.request()
      if (request.resourceType() === 'media' || request.resourceType() === 'font') {
        await route.abort()
        return
      }
      if (request.isNavigationRequest() && !request.frame().parentFrame() && !allowedNavigation(request.url())) {
        await route.abort()
        return
      }
      await route.fallback()
    }))

    let media: SocialMedia[] | undefined
    const inspectResponse = async (response: { url(): string; headers(): Record<string, string>; text(): Promise<string> }) => {
      if (!assertResponseUrl(response.url())) return
      const contentLength = Number(response.headers()['content-length'] || 0)
      if (contentLength > MAX_HTML_BYTES) return
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > MAX_HTML_BYTES) return
      try {
        const safeBody = body.replace(/</g, '\\u003c')
        const parsed = parseSocialPostHtml('douyin', `<script type="application/json">${safeBody}</script>`, source.id!)
        if (parsed.length > 0) media = parsed
      } catch {
        // A mismatched item or untrusted media URL is treated as no result;
        // the caller may continue with its existing yt-dlp fallback.
      }
    }
    context.on('response', response => { void inspectResponse(response).catch(() => undefined) })
    const pagePromise = context.newPage()
    void pagePromise.then(value => { if (deadlineExpired) void value.close().catch(() => undefined) }, () => undefined)
    page = await awaitDeadline(pagePromise)
    const navigation = page.goto(`https://www.douyin.com/video/${source.id}`, {
      waitUntil: 'domcontentloaded', timeout: Math.min(30_000, remaining())
    }).catch(() => undefined)
    await awaitDeadline(navigation)

    while (Date.now() < deadline && !media) {
      if (deadlineExpired) throw browserTimeout()
      if (await awaitDeadline(hasVerification(context))) throw verificationRequired()
      if (page && !page.isClosed()) {
        const html = await awaitDeadline(page.content().catch(() => ''))
        if (Buffer.byteLength(html, 'utf8') <= MAX_HTML_BYTES) {
          try {
            const parsed = parseSocialPostHtml('douyin', html, source.id)
            if (parsed.length > 0) media = parsed
          } catch { /* page state is incomplete or does not match the share id */ }
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))))
    }
    if (deadlineExpired) throw browserTimeout()
    if (await awaitDeadline(hasVerification(context))) throw verificationRequired()
    if (!media) {
      throw browserTimeout()
    }
    let latest
    try {
      latest = await awaitDeadline(Promise.resolve().then(() => store.read()))
    } catch {
      if (deadlineExpired) throw browserTimeout()
      throw authRequired()
    }
    if (latest.status !== 'authenticated') throw authRequired()
    return media
  } catch (error) {
    if (deadlineExpired) throw browserTimeout()
    if (error instanceof AppError) throw error
    throw new AppError('douyin_browser_error', '抖音官方页面暂时无法解析，请稍后重试', 502)
  } finally {
    clearTimeout(timeoutHandle)
    await closeResources()
    activeParse = false
  }
}
