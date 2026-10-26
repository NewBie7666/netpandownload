import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium, type Browser, type LaunchOptions, type Route } from 'playwright-core'
import { existsSync } from 'node:fs'
import { AppError } from '../../server/http.js'
import { extractAuthenticatedDouyin } from '../../server/providers/social/douyinBrowser.js'
import type { DouyinAuthStore, DouyinCookie, DouyinSessionState } from '../../server/auth/douyin/types.js'
import type { SocialMedia, SocialSource } from '../../server/providers/social/types.js'

const itemId = '1234567890123456'
const sessionValue = 'fixture-session-cookie-value-0123456789'
const mediaUrl = 'https://v3.douyinvod.com/video/fixture.mp4?x-sign=fixture'

function cookie(): DouyinCookie {
  return {
    name: 'sessionid', value: sessionValue, domain: '.douyin.com', path: '/',
    expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true, sameSite: 'Lax'
  }
}

function state(status: DouyinSessionState['status'] = 'authenticated'): DouyinSessionState {
  return { override: true, status, cookies: status === 'authenticated' ? [cookie()] : [], expiresAt: Date.now() + 3600_000 }
}

class FixtureStore implements DouyinAuthStore {
  reads = 0
  constructor(private readonly next: () => DouyinSessionState = () => state()) {}
  async read() { this.reads += 1; return this.next() }
  async save() { throw new Error('not used') }
  async revoke() { throw new Error('not used') }
}

type FixtureMode = 'success' | 'wrong-id' | 'untrusted' | 'verification' | 'hidden-verification'

function fixtureBody(mode: FixtureMode) {
  if (mode === 'verification' || mode === 'hidden-verification') {
    const visibility = mode === 'hidden-verification' ? 'display:none' : 'width:320px;height:240px'
    return `<!doctype html><iframe src="https://rmc.bytedance.com/verifycenter/captcha/v2" style="${visibility}"></iframe>`
  }
  const awemeId = mode === 'wrong-id' ? '9999999999999999' : itemId
  const url = mode === 'untrusted' ? 'https://evil.example/video.mp4' : mediaUrl
  const detail = { aweme_detail: { aweme_id: awemeId, video: { play_addr: { url_list: [url] } } } }
  return `<!doctype html><button id="page">登录</button><script>fetch('/aweme/v1/web/aweme/detail/')</script>` +
    (mode === 'success' ? '' : `<script>window._ROUTER_DATA = ${JSON.stringify(detail)}</script>`)
}

async function openFixture(mode: FixtureMode, suppliedStore?: FixtureStore, timeoutMs = 4000) {
  let browser: Browser | undefined
  let sawCookie = false
  let requestedOptions: LaunchOptions | undefined
  const launch = async (options: LaunchOptions) => {
    requestedOptions = options
    const launchOptions = { ...options, headless: true, args: [...(options.args || []), '--no-sandbox'] }
    try {
      browser = await chromium.launch(launchOptions)
    } catch (error) {
      const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      if (process.platform !== 'win32' || !existsSync(edgePath) || !String(error).includes('spawn UNKNOWN')) throw error
      browser = await chromium.launch({ ...launchOptions, executablePath: edgePath })
    }
    const nativeNewContext = browser.newContext.bind(browser)
    browser.newContext = async contextOptions => {
      const context = await nativeNewContext(contextOptions)
      const nativeRoute = context.route.bind(context)
      context.route = async (url, handler, routeOptions) => {
        await nativeRoute('**/*', route => fulfillFixture(route, mode, value => { sawCookie = value }))
        return nativeRoute(url, handler, routeOptions)
      }
      return context
    }
    return browser
  }
  const previous = {
    enabled: process.env.NETPAN_DOUYIN_LOGIN_ENABLED,
    configuredPath: process.env.NETPAN_CHROMIUM_PATH,
    headless: process.env.NETPAN_DOUYIN_HEADLESS,
    privateWeb: process.env.NETPAN_PRIVATE_WEB
  }
  process.env.NETPAN_DOUYIN_LOGIN_ENABLED = 'true'
  if (process.platform === 'win32') process.env.NETPAN_CHROMIUM_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  else delete process.env.NETPAN_CHROMIUM_PATH
  process.env.NETPAN_DOUYIN_HEADLESS = 'true'
  process.env.NETPAN_PRIVATE_WEB = 'false'
  const source: SocialSource = { platform: 'douyin', id: itemId, url: `https://www.douyin.com/video/${itemId}` }
  const store = suppliedStore || new FixtureStore()
  try {
    const media = await extractAuthenticatedDouyin(source, { store, launchBrowser: launch, timeoutMs })
    return { browser: browser!, media, sawCookie, requestedOptions, store }
  } catch (error) {
    await browser?.close().catch(() => {})
    throw error
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = key === 'enabled' ? 'NETPAN_DOUYIN_LOGIN_ENABLED' : key === 'configuredPath' ? 'NETPAN_CHROMIUM_PATH' : key === 'headless' ? 'NETPAN_DOUYIN_HEADLESS' : 'NETPAN_PRIVATE_WEB'
      if (value === undefined) delete process.env[envKey]
      else process.env[envKey] = value
    }
  }
}

async function fulfillFixture(route: Route, mode: FixtureMode, cookieSeen: (value: boolean) => void) {
  const request = route.request()
  const url = new URL(request.url())
  if (url.hostname === 'www.douyin.com' && url.pathname.startsWith('/video/')) {
    await route.fulfill({ status: 200, contentType: 'text/html', body: fixtureBody(mode) })
    return
  }
  if (url.hostname === 'www.douyin.com' && /^\/aweme\/v1\/web\/aweme\/detail\/?$/.test(url.pathname)) {
    cookieSeen(Boolean(request.headers().cookie))
    const detail = mode === 'wrong-id'
      ? { aweme_detail: { aweme_id: '9999999999999999', video: { play_addr: { url_list: [mediaUrl] } } } }
      : mode === 'untrusted'
        ? { aweme_detail: { aweme_id: itemId, video: { play_addr: { url_list: ['https://evil.example/video.mp4'] } } } }
        : { aweme_detail: { aweme_id: itemId, video: { play_addr: { url_list: [mediaUrl] } } } }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) })
    return
  }
  if (url.hostname === 'rmc.bytedance.com' && url.pathname === '/verifycenter/captcha/v2') {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<body>安全验证</body>' })
    return
  }
  await route.abort()
}

test('authenticated browser reuses managed cookie and parses official detail JSON', async () => {
  // The helper above always starts a success fixture; make the response route
  // prove that the saved cookie reached the official request.
  const opened = await openFixture('success')
  try {
    assert.equal(opened.requestedOptions?.chromiumSandbox, true)
    assert.ok(opened.sawCookie)
    assert.equal(opened.media?.length, 1)
    assert.equal(opened.media?.[0].url, mediaUrl)
    assert.equal(opened.media?.[0].file.name, `douyin_${itemId}_01.mp4`)
    assert.equal(opened.browser.isConnected(), false)
  } finally {
    await opened.browser.close().catch(() => {})
  }
})

test('wrong ids and untrusted media do not escape parser validation', async () => {
  await assert.rejects(() => openFixture('wrong-id', undefined, 1000), (error: unknown) =>
    error instanceof AppError && error.error === 'douyin_browser_timeout')
  await assert.rejects(() => openFixture('untrusted', undefined, 1000), (error: unknown) =>
    error instanceof AppError && error.error === 'douyin_browser_timeout')
})

test('verification is surfaced without exposing upstream response data', async () => {
  await assert.rejects(
    () => openFixture('verification'),
    (error: unknown) => error instanceof AppError && error.error === 'verification_required'
  )
  await assert.rejects(
    () => openFixture('hidden-verification', undefined, 1000),
    (error: unknown) => error instanceof AppError && error.error === 'douyin_browser_timeout'
  )
})

test('logout race rejects a media result when managed auth changes before return', async () => {
  let reads = 0
  const store = new FixtureStore(() => ++reads === 1 ? state() : state('revoked'))
  await assert.rejects(
    () => openFixture('success', store),
    (error: unknown) => error instanceof AppError && error.error === 'auth_required'
  )
})

test('concurrent authenticated parses are rejected while the first browser is active', async () => {
  const first = openFixture('wrong-id', undefined, 1000)
  await new Promise(resolve => setTimeout(resolve, 25))
  await assert.rejects(
    () => openFixture('success', undefined, 1000),
    (error: unknown) => error instanceof AppError && error.error === 'douyin_browser_busy'
  )
  await assert.rejects(() => first, (error: unknown) =>
    error instanceof AppError && error.error === 'douyin_browser_timeout')
})
