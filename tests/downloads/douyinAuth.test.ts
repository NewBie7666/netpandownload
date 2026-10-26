import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import express from 'express'
import { DouyinAuthManager } from '../../server/auth/douyin/manager.js'
import type {
  DouyinAuthStore,
  DouyinBrowserDriver,
  DouyinBrowserSession,
  DouyinBrowserSnapshot,
  DouyinCookie,
  DouyinSessionState
} from '../../server/auth/douyin/types.js'
import { createDouyinAuthRouter } from '../../server/routes/douyinAuth.js'

const PNG = Buffer.from('89504e470d0a1a0a010203', 'hex')
const BASE_TIME = 1_800_000_000_000

function cookie(value = 'cookie-secret-0123456789'): DouyinCookie {
  return {
    name: 'sessionid',
    value,
    domain: '.douyin.com',
    path: '/',
    expires: BASE_TIME + 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  }
}

class FakeStore implements DouyinAuthStore {
  state: DouyinSessionState = { override: false, status: 'absent', cookies: [], expiresAt: null }
  saveCalls: DouyinCookie[][] = []
  revokeCalls = 0

  async read() {
    return this.state
  }

  async save(cookies: DouyinCookie[]) {
    this.saveCalls.push(cookies)
    this.state = { override: true, status: 'authenticated', cookies, expiresAt: cookies[0]?.expires || null }
  }

  async revoke() {
    this.revokeCalls += 1
    this.state = { override: true, status: 'logged_out', cookies: [], expiresAt: null }
  }
}

class FakeBrowser implements DouyinBrowserSession {
  readonly snapshots: DouyinBrowserSnapshot[]
  closeCalls = 0
  snapshotCalls = 0

  constructor(snapshots: DouyinBrowserSnapshot[]) {
    this.snapshots = snapshots
  }

  async snapshot() {
    this.snapshotCalls += 1
    return this.snapshots[Math.min(this.snapshotCalls - 1, this.snapshots.length - 1)] as DouyinBrowserSnapshot
  }

  async close() {
    this.closeCalls += 1
  }
}

class FakeDriver implements DouyinBrowserDriver {
  readonly browsers: FakeBrowser[]
  availableValue = true
  openCalls = 0
  private readonly openWaiters: Array<(browser: FakeBrowser) => void> = []

  constructor(browsers: FakeBrowser[]) {
    this.browsers = browsers
  }

  async available() {
    return this.availableValue
  }

  async open(_signal: AbortSignal) {
    this.openCalls += 1
    const browser = this.browsers.shift()
    if (!browser) throw new Error('no fake browser')
    if (this.openWaiters.length > 0) {
      const resolve = this.openWaiters.shift() as (value: FakeBrowser) => void
      resolve(browser)
      return browser
    }
    return browser
  }

}

class LateOpenDriver implements DouyinBrowserDriver {
  readonly browser: FakeBrowser
  availableValue = true
  openCalls = 0
  private resolveOpen!: (browser: FakeBrowser) => void
  readonly opened = new Promise<FakeBrowser>((resolve) => {
    this.resolveOpen = resolve
  })

  constructor(browser: FakeBrowser) {
    this.browser = browser
  }

  async available() {
    return this.availableValue
  }

  async open(_signal: AbortSignal) {
    this.openCalls += 1
    return this.opened
  }

  resolve() {
    this.resolveOpen(this.browser)
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fake auth state')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function listen(manager: DouyinAuthManager): Promise<{ server: Server; base: string }> {
  const app = express()
  app.use(express.json())
  app.use(createDouyinAuthRouter(manager))
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error && typeof error === 'object' && 'status' in error && 'error' in error && 'message' in error) {
      const value = error as { status: number; error: string; message: string }
      res.status(value.status).json({ ok: false, error: value.error, message: value.message })
      return
    }
    res.status(500).json({ ok: false, error: 'internal_error', message: 'unexpected' })
  })
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake server did not bind')
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function stop(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('starts with a pending QR state and serves only the active PNG', async () => {
  let now = BASE_TIME
  const store = new FakeStore()
  const browser = new FakeBrowser([{ state: 'waiting_scan', qrPng: PNG }])
  const manager = new DouyinAuthManager({
    store,
    driver: new FakeDriver([browser]),
    now: () => now,
    tickMs: 5
  })

  const started = await manager.start()
  assert.equal(started.state, 'starting')
  assert.match(started.sessionId || '', /^[a-f0-9]{32}$/)
  const sessionId = started.sessionId as string
  await waitFor(() => browser.snapshotCalls > 0)
  const status = await manager.status(sessionId)
  assert.equal(status.state, 'waiting_scan')
  assert.equal(status.loggedIn, false)
  assert.match(status.qrImageUrl || '', new RegExp(`^/api/auth/douyin/qr/${sessionId}/image\\?v=[a-f0-9]{16}$`))
  assert.deepEqual(await manager.image(sessionId), PNG)

  now += 121_000
  assert.equal((await manager.status(sessionId)).state, 'expired')
  await assert.rejects(() => manager.image(sessionId), (error: unknown) => {
    return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409)
  })
  await waitFor(() => browser.closeCalls === 1)
  await manager.close()
})

test('serializes concurrent non-forced starts into one browser session', async () => {
  const store = new FakeStore()
  const browser = new FakeBrowser([{ state: 'waiting_scan', qrPng: PNG }])
  const driver = new FakeDriver([browser])
  const manager = new DouyinAuthManager({ store, driver, now: () => BASE_TIME, tickMs: 5 })

  const statuses = await Promise.all([manager.start(), manager.start(), manager.start()])
  const sessionIds = new Set(statuses.map((status) => status.sessionId))
  assert.equal(sessionIds.size, 1)
  assert.equal(driver.openCalls, 1)
  await manager.close()
})

test('persists authenticated cookies and a new manager reports the stored login', async () => {
  const store = new FakeStore()
  let authenticatedCallbacks = 0
  const browser = new FakeBrowser([
    { state: 'waiting_scan', qrPng: PNG },
    { state: 'scanned', cookies: [cookie()] }
  ])
  const manager = new DouyinAuthManager({
    store,
    driver: new FakeDriver([browser]),
    now: () => BASE_TIME,
    tickMs: 5,
    onAuthenticated: () => { authenticatedCallbacks += 1 }
  })
  const started = await manager.start()
  const sessionId = started.sessionId as string
  await waitFor(() => store.saveCalls.length === 1)
  const authenticated = await manager.status(sessionId)
  assert.equal(authenticated.state, 'authenticated')
  assert.equal(authenticated.loggedIn, true)
  assert.equal(authenticated.qrImageUrl, undefined)
  assert.equal(authenticatedCallbacks, 1)

  const second = new DouyinAuthManager({
    store,
    driver: new FakeDriver([]),
    now: () => BASE_TIME
  })
  assert.deepEqual(await second.status(), {
    state: 'authenticated',
    loggedIn: true,
    available: true,
    expiresAt: new Date(BASE_TIME + 24 * 60 * 60 * 1000).toISOString(),
    message: '抖音已登录'
  })

  store.state = { override: true, status: 'expired', cookies: [], expiresAt: BASE_TIME + 1_000 }
  const expiredStored = await manager.status()
  assert.equal(expiredStored.state, 'expired')
  assert.equal(expiredStored.loggedIn, false)
  assert.equal(expiredStored.message, '登录态已过期，请重新扫码')
  assert.equal(expiredStored.expiresAt, new Date(BASE_TIME + 1_000).toISOString())

  store.state = { override: true, status: 'invalid', cookies: [], expiresAt: null }
  const corruptedStored = await manager.status()
  assert.equal(corruptedStored.state, 'logged_out')
  assert.equal(corruptedStored.loggedIn, false)
  await manager.close()
  await second.close()
})

test('reuses an existing authenticated store without opening a browser unless forced', async () => {
  const store = new FakeStore()
  store.state = {
    override: true,
    status: 'authenticated',
    cookies: [cookie()],
    expiresAt: BASE_TIME + 24 * 60 * 60 * 1000
  }
  const browser = new FakeBrowser([{ state: 'waiting_scan', qrPng: PNG }])
  const driver = new FakeDriver([browser])
  const manager = new DouyinAuthManager({ store, driver, now: () => BASE_TIME, tickMs: 5 })

  const existing = await manager.start()
  assert.equal(existing.state, 'authenticated')
  assert.equal(driver.openCalls, 0)

  const forced = await manager.start(true)
  assert.equal(forced.state, 'starting')
  assert.equal(driver.openCalls, 1)
  await manager.close()
})

test('logout aborts a pending open and ignores its late authenticated cookies', async () => {
  const store = new FakeStore()
  const browser = new FakeBrowser([{ state: 'scanned', cookies: [cookie('late-secret-0123456789')] }])
  const driver = new LateOpenDriver(browser)
  const manager = new DouyinAuthManager({ store, driver, now: () => BASE_TIME, tickMs: 5 })
  await manager.start()
  await manager.logout()
  driver.resolve()
  await waitFor(() => browser.closeCalls === 1)
  assert.equal(store.saveCalls.length, 0)
  assert.equal(store.revokeCalls, 1)
  assert.equal((await manager.status()).loggedIn, false)
})

test('verification_required remains pending and never saves cookies by itself', async () => {
  let now = BASE_TIME
  const store = new FakeStore()
  const browser = new FakeBrowser([{ state: 'verification_required', qrPng: PNG, cookies: [cookie()] }])
  const manager = new DouyinAuthManager({ store, driver: new FakeDriver([browser]), now: () => now, ttlMs: 50, tickMs: 5 })
  const started = await manager.start()
  const sessionId = started.sessionId as string
  await waitFor(() => browser.snapshotCalls > 0)
  assert.equal((await manager.status(sessionId)).state, 'verification_required')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.saveCalls.length, 0)
  now += 100
  assert.equal((await manager.status(sessionId)).state, 'expired')
  await manager.close()
})

test('rejects malformed and unknown session ids without exposing browser errors', async () => {
  const manager = new DouyinAuthManager({ store: new FakeStore(), driver: new FakeDriver([]), now: () => BASE_TIME })
  await assert.rejects(() => manager.status('not-a-session'), (error: unknown) => {
    return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 400)
  })
  const unknown = '0123456789abcdef0123456789abcdef'
  await assert.rejects(() => manager.image(unknown), (error: unknown) => {
    return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 404)
  })
})

test('router returns a no-store PNG and never serializes cookie values', async () => {
  const store = new FakeStore()
  const secret = 'router-secret-0123456789'
  const browser = new FakeBrowser([{ state: 'waiting_scan', qrPng: PNG }, { state: 'scanned', cookies: [cookie(secret)] }])
  const manager = new DouyinAuthManager({ store, driver: new FakeDriver([browser]), now: () => BASE_TIME, tickMs: 1_000 })
  const { server, base } = await listen(manager)
  try {
    const startedResponse = await fetch(`${base}/qr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const started = await startedResponse.json() as { result: { sessionId: string } }
    const sessionId = started.result.sessionId
    await waitFor(() => browser.snapshotCalls > 0)
    const imageResponse = await fetch(`${base}/qr/${sessionId}/image`)
    assert.equal(imageResponse.status, 200)
    assert.equal(imageResponse.headers.get('content-type'), 'image/png')
    assert.equal(imageResponse.headers.get('cache-control'), 'no-store')
    assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), PNG)

    await waitFor(() => store.saveCalls.length === 1, 2_000)
    const statusResponse = await fetch(`${base}/status?sessionId=${sessionId}`)
    const statusText = await statusResponse.text()
    assert.equal(statusResponse.status, 200)
    assert.equal(statusText.includes(secret), false)

    const invalidResponse = await fetch(`${base}/status?sessionId=bad`)
    const invalidBody = await invalidResponse.text()
    assert.equal(invalidResponse.status, 400)
    assert.equal(invalidBody.includes(secret), false)
  } finally {
    await manager.close()
    await stop(server)
  }
})
