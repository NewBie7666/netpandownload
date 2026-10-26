import { chromium, type Browser, type BrowserContext, type Page, type LaunchOptions } from 'playwright-core'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { AppError } from '../../http.js'
import type { DouyinBrowserDriver, DouyinBrowserSession, DouyinBrowserSnapshot } from './types.js'

const LOGIN_URL = 'https://www.douyin.com/'
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function officialHost(host: string) {
  return host === 'douyin.com' || host.endsWith('.douyin.com') || host === 'bytedance.com' || host.endsWith('.bytedance.com')
}
function isQrResponse(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === 'https:' && ['login.douyin.com', 'sso.douyin.com', 'www.douyin.com'].includes(url.hostname) && /\/(?:passport\/web\/)?get_qrcode\/?$/.test(url.pathname)
  } catch { return false }
}
function validPng(bytes: Buffer) {
  return bytes.length >= 8 && bytes.length <= 256 * 1024 && bytes.subarray(0, 8).equals(PNG)
}
async function officialQrImage(value: unknown): Promise<Buffer | undefined> {
  if (typeof value !== 'string' || value.length > 350000) return undefined
  const encoded = value.replace(/^data:image\/png;base64,/, '')
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) {
    const bytes = Buffer.from(encoded, 'base64')
    if (validPng(bytes)) return bytes
  }
  try {
    const url = new URL(value)
    // Only an unmodified official login ticket may be rendered into a QR image.
    if ((url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) || url.protocol === 'snssdk1128:') {
      return await QRCode.toBuffer(value, { type: 'png', width: 256, margin: 2 })
    }
  } catch { /* not an official image or ticket */ }
  return undefined
}

export async function resolveDouyinBrowserPath(): Promise<string | undefined> {
  if (process.env.NETPAN_DOUYIN_LOGIN_ENABLED === 'false') return undefined
  const configured = String(process.env.NETPAN_CHROMIUM_PATH || '').trim()
  const paths = configured ? [configured] : [
    chromium.executablePath(),
    ...(process.platform === 'win32' ? [
      path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')
    ] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'])
  ]
  for (const candidate of paths) {
    if (!path.isAbsolute(candidate)) continue
    try { await access(candidate, constants.X_OK); return candidate } catch { /* next installed executable */ }
  }
  return undefined
}

export class PlaywrightDouyinBrowserDriver implements DouyinBrowserDriver {
  constructor(private readonly launchBrowser: (options: LaunchOptions) => Promise<Browser> = options => chromium.launch(options)) {}
  async available() { return Boolean(await resolveDouyinBrowserPath()) }
  async open(signal: AbortSignal): Promise<DouyinBrowserSession> {
    const executablePath = await resolveDouyinBrowserPath()
    if (!executablePath) throw new AppError('douyin_browser_unavailable', '登录组件尚未配置，请管理员安装受支持的 Chromium 浏览器', 503)
    if (signal.aborted) throw new AppError('douyin_login_cancelled', '登录已取消', 409)
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    let closed = false
    let qrPng: Buffer | undefined
    let active: Page | undefined
    let clicked = false
    const close = async () => {
      if (closed) return
      closed = true
      signal.removeEventListener('abort', onAbort)
      try { await context?.close() } catch { /* already closed */ }
      try { await browser?.close({ reason: 'Douyin login session ended' }) } catch { /* already closed */ }
    }
    const onAbort = () => { void close() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      browser = await this.launchBrowser({
        executablePath,
        headless: process.env.NETPAN_DOUYIN_HEADLESS === 'false' ? false : process.env.NETPAN_DOUYIN_HEADLESS === 'true' || process.env.NETPAN_PRIVATE_WEB === 'true',
        chromiumSandbox: true,
        timeout: 30000,
        args: ['--disable-dev-shm-usage', '--mute-audio', '--no-first-run', '--window-size=1100,850']
      })
      if (signal.aborted || closed) { await browser.close(); throw new Error('cancelled') }
      context = await browser.newContext({ viewport: { width: 1100, height: 850 }, locale: 'zh-CN', acceptDownloads: false })
      // Fresh, non-persistent context: never open or import a personal browser profile.
      await context.route('**/*', async route => {
        const req = route.request()
        if (req.resourceType() === 'media') { await route.abort(); return }
        if (req.isNavigationRequest() && !req.frame().parentFrame()) {
          try {
            const target = new URL(req.url())
            if (target.protocol !== 'https:' || !officialHost(target.hostname)) { await route.abort(); return }
          } catch { await route.abort(); return }
        }
        await route.fallback()
      })
      const observe = (page: Page) => {
        page.on('response', response => {
          if (!isQrResponse(response.url())) return
          void (async () => {
            try {
              const headerLength = Number(response.headers()['content-length'] || 0)
              if (headerLength > 512 * 1024) return
              const text = await response.text()
              if (text.length > 512 * 1024) return
              const payload = JSON.parse(text) as { data?: Record<string, unknown> }
              for (const key of ['qrcode', 'qrcode_url', 'qrcodeUrl']) {
                const image = await officialQrImage(payload.data?.[key])
                if (image && !closed) { qrPng = image; break }
              }
            } catch { /* no upstream response or login ticket is logged */ }
          })()
        })
      }
      active = await context.newPage()
      observe(active)
      context.on('page', page => { observe(page); active = page; clicked = false })
      await active.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => undefined)
      if (closed || signal.aborted) { await close(); throw new Error('cancelled') }
      const loginContext = context
      return {
        close,
        async snapshot(): Promise<DouyinBrowserSnapshot> {
          if (closed || !active || active.isClosed()) return { state: 'error' }
          const cookies = (await loginContext.cookies()).filter(cookie => cookie.domain.replace(/^\./, '') === 'douyin.com' || cookie.domain.endsWith('.douyin.com') || cookie.domain.replace(/^\./, '') === 'iesdouyin.com' || cookie.domain.endsWith('.iesdouyin.com'))
          if (cookies.some(cookie => ['sessionid', 'sessionid_ss'].includes(cookie.name) && cookie.value.length >= 16 && (cookie.expires <= 0 || cookie.expires * 1000 > Date.now()))) {
            return { state: 'scanned', cookies }
          }
          let verification = false
          let expired = false
          let scanned = false
          for (const page of loginContext.pages()) {
            for (const frame of page.frames()) {
              let host = ''
              try { host = new URL(frame.url()).hostname } catch { continue }
              if (!officialHost(host)) continue
              const body = await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '')
              if (/二维码.{0,8}(已失效|过期)|刷新二维码/.test(body)) expired = true
              if (/扫码成功|请在手机.{0,8}确认|已扫描/.test(body)) scanned = true
              if (/拖动滑块|安全验证|完成验证|验证码/.test(body) && /verify|captcha/.test(frame.url())) verification = true
              if (/verifycenter\/captcha|captcha\/verify/.test(frame.url())) {
                try { const el = await frame.frameElement(); const box = await el.boundingBox(); if (box && box.width > 40 && box.height > 40 && await el.isVisible()) verification = true } catch { /* frame disappeared */ }
              }
              if (!qrPng) {
                const candidates = frame.locator('img[alt*="二维码"], img[alt*="扫码"], [class*="qrcode" i] img, [class*="qr-code" i] img, canvas[class*="qrcode" i], [class*="qrcode" i] canvas')
                const count = Math.min(await candidates.count(), 8)
                for (let i = 0; i < count; i++) {
                  const element = candidates.nth(i)
                  const box = await element.boundingBox()
                  if (!box || box.width < 100 || box.width > 600 || box.height < 100 || box.height > 600 || Math.abs(box.width / box.height - 1) > 0.2) continue
                  const image = await element.screenshot({ type: 'png', timeout: 2000 }).catch(() => undefined)
                  if (image && validPng(image)) { qrPng = image; break }
                }
              }
            }
          }
          if (expired) return { state: 'expired' }
          if (!qrPng && !clicked && !verification) {
            const selectors = [active.getByRole('button', { name: '登录', exact: true }), active.getByText('登录', { exact: true })]
            for (const selector of selectors) {
              if (!await selector.count() || !await selector.first().isVisible()) continue
              try { await selector.first().click({ timeout: 2000 }); clicked = true; break } catch { /* try the visible official entry */ }
            }
          }
          return { state: verification ? 'verification_required' : scanned ? 'scanned' : 'waiting_scan', ...(qrPng && !verification ? { qrPng } : {}) }
        }
      }
    } catch {
      await close()
      throw new AppError('douyin_browser_unavailable', '无法打开抖音登录窗口，请检查浏览器组件或运行环境', 503)
    }
  }
}
