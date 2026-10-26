import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium, type Browser, type LaunchOptions, type Route } from 'playwright-core'
import { existsSync } from 'node:fs'
import { PlaywrightDouyinBrowserDriver } from '../../server/auth/douyin/browserDriver.js'

const fixtureSessionId = '0123456789abcdef0123456789abcdef'
const fixtureCookie = 'fixture-session-cookie-value-0123456789'

type FixtureMode = 'qr' | 'cookie'

function htmlFor(mode: FixtureMode) {
  const cookie = mode === 'cookie'
    ? `document.cookie = 'sessionid=${fixtureCookie}; Path=/; Secure'`
    : ''
  const autoQr = mode === 'qr'
    ? `setTimeout(() => fetch('https://login.douyin.com/passport/web/get_qrcode').catch(() => {}), 50)`
    : ''
  return `<!doctype html><html lang="zh-CN"><body><button type="button" id="login">登录</button><script>${cookie}
    document.getElementById('login').addEventListener('click', () => {
      fetch('https://login.douyin.com/passport/web/get_qrcode').catch(() => {})
    })
    ${autoQr}
  </script></body></html>`
}

async function fulfillFixture(route: Route, mode: FixtureMode, fixtureNavigationUrls: string[]) {
  const request = route.request()
  const url = new URL(request.url())
  if (url.hostname === 'www.douyin.com' && url.pathname === '/') {
    if (request.isNavigationRequest() && !request.frame().parentFrame()) fixtureNavigationUrls.push(request.url())
    await route.fulfill({ status: 200, contentType: 'text/html', body: htmlFor(mode) })
    return
  }
  if (url.hostname === 'login.douyin.com' && /\/(?:passport\/web\/)?get_qrcode\/?$/.test(url.pathname)) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.douyin.com' },
      body: JSON.stringify({ data: { qrcode_url: `https://login.douyin.com/qr-ticket?session=${fixtureSessionId}` } })
    })
    return
  }
  if (url.hostname === 'rmc.bytedance.com' && url.pathname === '/verifycenter/captcha/v2') {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body>安全验证</body>' })
    return
  }
  // Every request in this fixture is handled locally. This prevents an accidental
  // network request from turning the test into a live Douyin check.
  await route.abort()
}

async function openFixture(mode: FixtureMode) {
  const navigationUrls: string[] = []
  const fixtureNavigationUrls: string[] = []
  let browser: Browser | undefined
  let requestedOptions: LaunchOptions | undefined
  const launch = async (options: LaunchOptions) => {
    requestedOptions = options
    const launchOptions = { ...options, headless: true, args: [...(options.args || []), '--no-sandbox'] }
    try {
      browser = await chromium.launch(launchOptions)
    } catch (error) {
      // A Windows runner may reject the bundled executable with spawn UNKNOWN.
      // In that fixture-only case, use the installed Chromium-based Edge.
      const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      if (process.platform !== 'win32' || !existsSync(edgePath) || !String(error).includes('spawn UNKNOWN')) throw error
      browser = await chromium.launch({ ...launchOptions, executablePath: edgePath })
    }
    const nativeNewContext = browser.newContext.bind(browser)
    browser.newContext = async (contextOptions) => {
      const context = await nativeNewContext(contextOptions)
      context.on('request', request => {
        if (request.isNavigationRequest() && !request.frame().parentFrame()) navigationUrls.push(request.url())
      })
      const nativeRoute = context.route.bind(context)
      // Install fixture interception first. The driver's route is registered
      // afterward and falls back to this handler for controlled responses.
      context.route = async (url, handler, options) => {
        await nativeRoute('**/*', route => fulfillFixture(route, mode, fixtureNavigationUrls))
        return nativeRoute(url, handler, options)
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
  delete process.env.NETPAN_CHROMIUM_PATH
  process.env.NETPAN_DOUYIN_HEADLESS = 'true'
  process.env.NETPAN_PRIVATE_WEB = 'false'

  const driver = new PlaywrightDouyinBrowserDriver(launch)
  const controller = new AbortController()
  try {
    const session = await driver.open(controller.signal)
    const context = browser!.contexts()[0]
    return { browser: browser!, controller, session, page: context.pages()[0], navigationUrls, fixtureNavigationUrls, requestedOptions, restore: () => restoreEnv(previous) }
  } catch (error) {
    await browser?.close().catch(() => {})
    restoreEnv(previous)
    throw error
  }
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    const envKey = key === 'enabled' ? 'NETPAN_DOUYIN_LOGIN_ENABLED' : key === 'configuredPath' ? 'NETPAN_CHROMIUM_PATH' : key === 'headless' ? 'NETPAN_DOUYIN_HEADLESS' : 'NETPAN_PRIVATE_WEB'
    if (value === undefined) delete process.env[envKey]
    else process.env[envKey] = value
  }
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    value = await read()
  }
  return value
}

test('Douyin browser adapter captures an official QR ticket through a real Chromium fixture', async () => {
  const opened = await openFixture('qr')
  try {
    assert.equal(opened.requestedOptions?.chromiumSandbox, true)
    assert.equal(opened.requestedOptions?.headless, true)
    const snapshot = await waitFor(() => opened.session.snapshot(), value => Boolean(value.qrPng))
    assert.equal(snapshot.state, 'waiting_scan')
    assert.ok(snapshot.qrPng && snapshot.qrPng.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    assert.equal(opened.navigationUrls[0], 'https://www.douyin.com/')
    assert.ok(opened.navigationUrls.every(url => new URL(url).hostname.endsWith('douyin.com')))
    const evilUrl = 'https://evil.example.test/'
    await opened.page.goto(evilUrl, { waitUntil: 'domcontentloaded', timeout: 2000 }).catch(() => undefined)
    assert.equal(opened.page.url(), 'https://www.douyin.com/')
    assert.ok(opened.navigationUrls.includes(evilUrl))
    assert.equal(opened.fixtureNavigationUrls.includes(evilUrl), false)
  } finally {
    await opened.session.close()
    opened.restore()
  }
})

test('Douyin browser adapter hides QR data while official verification is required', async () => {
  const opened = await openFixture('qr')
  try {
    const qrSnapshot = await waitFor(() => opened.session.snapshot(), value => Boolean(value.qrPng))
    assert.equal(qrSnapshot.state, 'waiting_scan')
    assert.ok(qrSnapshot.qrPng)
    await opened.page.evaluate(() => {
      const iframe = document.createElement('iframe')
      iframe.title = 'official verification'
      iframe.src = 'https://rmc.bytedance.com/verifycenter/captcha/v2'
      iframe.style.width = '320px'
      iframe.style.height = '240px'
      document.body.append(iframe)
    })
    const verificationSnapshot = await waitFor(() => opened.session.snapshot(), value => value.state === 'verification_required')
    assert.equal(verificationSnapshot.state, 'verification_required')
    assert.equal(verificationSnapshot.qrPng, undefined)
  } finally {
    await opened.session.close()
    opened.restore()
  }
})

test('Douyin browser adapter recognizes a trusted session cookie and abort closes Chromium', async () => {
  const opened = await openFixture('cookie')
  try {
    const snapshot = await opened.session.snapshot()
    assert.equal(snapshot.state, 'scanned')
    assert.ok(snapshot.cookies?.some(cookie => cookie.name === 'sessionid' && cookie.value === fixtureCookie))

    opened.controller.abort()
    await waitFor(async () => opened.session.snapshot(), value => value.state === 'error')
    await waitFor(async () => opened.browser.isConnected(), value => value === false)
    assert.equal(opened.browser.isConnected(), false)
  } finally {
    await opened.session.close().catch(() => {})
    opened.restore()
  }
})
