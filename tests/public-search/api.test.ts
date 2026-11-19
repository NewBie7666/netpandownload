import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { PublicSettings } from '../../public-search/server/app.js'
import { createPublicApp, readSettings } from '../../public-search/server/app.js'
import { validateQuery } from '../../public-search/server/search.js'
import { proxyRequest } from './http.js'

const TOKEN = 'public-search-test-token-0123456789'
const HOST = 'search.example.test'
const IP = '203.0.113.1'

type SearchResult = {
  query: string
  items: Array<Record<string, unknown>>
  movies: Array<Record<string, unknown>>
  sources: Array<Record<string, unknown>>
}
type SearchStub = (params: ReturnType<typeof validateQuery>) => Promise<SearchResult>

const sampleResult = (query = 'sample'): SearchResult => ({
  query,
  items: [{ hash: '0123456789abcdef0123456789abcdef01234567', title: 'Sample result', size: '1 GB', magnet: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', source: 'test', seeders: 3 }],
  movies: [{ code: 'ABP-123', title: 'Sample movie' }],
  sources: [{ id: 'test', name: 'Test source', ok: true, count: 1 }]
})

function settings(overrides: Partial<PublicSettings> = {}): PublicSettings {
  return {
    origin: `https://${HOST}`,
    proxyToken: TOKEN,
    port: 3100,
    perIpLimit: 20,
    globalLimit: 120,
    concurrency: 4,
    perIpConcurrency: 2,
    ...overrides
  }
}

async function listen(search: SearchStub, override: Partial<PublicSettings> = {}) {
  const app = createPublicApp(settings(override), search)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function close(server: ReturnType<ReturnType<typeof createPublicApp>['listen']>) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

type RequestOptions = RequestInit & { host?: string; ip?: string; token?: string; origin?: string }

async function request(base: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const { host = HOST, ip = IP, token = TOKEN, origin, ...init } = options
  const headers = new Headers(init.headers)
  headers.set('host', host)
  headers.set('x-real-ip', ip)
  headers.set('x-public-search-token', token)
  if (origin !== undefined) headers.set('origin', origin)
  return proxyRequest(base + path, { ...init, headers })
}

async function json(response: Response): Promise<Record<string, any>> {
  return JSON.parse(await response.text()) as Record<string, any>
}

test('public API exposes only search and health, validates inputs, and forwards no secrets', async () => {
  let calls = 0
  let received: ReturnType<typeof validateQuery> | undefined
  const search: SearchStub = async params => {
    calls++
    received = params
    return sampleResult(params.q)
  }
  const { server, base } = await listen(search)
  try {
    const success = await request(base, '/api/search?q=book&mode=general&category=book&source=academic')
    assert.equal(success.status, 200)
    const successBody = await json(success)
    assert.equal(successBody.ok, true)
    assert.equal(successBody.result.query, 'book')
    assert.equal(received?.mode, 'general')
    assert.equal(received?.category, 'book')
    assert.equal(received?.source, 'academic')
    assert.equal(success.headers.get('x-powered-by'), null)
    assert.equal(success.headers.get('x-content-type-options'), 'nosniff')
    assert.match(success.headers.get('content-security-policy') || '', /default-src 'none'/)

    const health = await request(base, '/api/health')
    assert.equal(health.status, 200)
    const healthBody = await json(health)
    assert.deepEqual(healthBody, { ok: true, result: { service: 'public-search' } })
    assert.doesNotMatch(JSON.stringify(healthBody), /releaseSha|cookie|token|password|download/i)

    const invalid = [
      '/api/search',
      '/api/search?q=a',
      '/api/search?q=sample&mode=unknown',
      '/api/search?q=sample&extra=1',
      '/api/search?q=sample&q=other',
      '/api/search?q=sample&category=invalid',
      '/api/search?q=sample&source=https%3A%2F%2Fevil.example',
      '/api/search?q=ABP-123&mode=exact&category[]=book'
    ]
    for (const path of invalid) {
      const response = await request(base, path)
      assert.equal(response.status, 400, path)
      const body = await json(response)
      assert.equal(body.ok, false, path)
      assert.equal(body.error, 'invalid_query', path)
    }
    assert.equal(calls, 1)

    const forbiddenPaths = [
      '/api/downloads', '/api/download-engine', '/api/providers', '/api/quark', '/api/product',
      '/api/decision', '/api/auth/douyin', '/api/settings', '/api/history', '/api/private/file',
      '/api/search/', '/api/search//', '/api/%73earch', '/api/search%2F..%2Fdownloads'
    ]
    for (const path of forbiddenPaths) {
      const response = await request(base, path)
      assert.equal(response.status, 404, path)
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
      const response = await request(base, '/api/search?q=sample', { method, body: method === 'POST' ? '{}' : undefined })
      assert.equal(response.status, 404, method)
    }
    assert.equal(calls, 1)
  } finally {
    await close(server)
  }
})

test('proxy token, host, origin and client address are fail-closed; X-Forwarded-For is ignored', async () => {
  let calls = 0
  const search: SearchStub = async params => { calls++; return sampleResult(params.q) }
  const { server, base } = await listen(search)
  try {
    const missingToken = await request(base, '/api/health', { token: '' })
    assert.equal(missingToken.status, 403)
    const spoofedToken = await request(base, '/api/health', { token: 'wrong-token', headers: { 'x-forwarded-for': IP } })
    assert.equal(spoofedToken.status, 403)
    const wrongHost = await request(base, '/api/health', { host: 'localhost' })
    assert.equal(wrongHost.status, 403)
    const crossOrigin = await request(base, '/api/health', { origin: 'https://evil.example' })
    assert.equal(crossOrigin.status, 403)
    const crossSite = await request(base, '/api/health', { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.status, 403)
    const invalidIp = await request(base, '/api/search?q=sample', { ip: 'not-an-ip' })
    assert.equal(invalidIp.status, 403)
    const ignoredXff = await request(base, '/api/search?q=sample', { headers: { 'x-forwarded-for': '10.0.0.1' } })
    assert.equal(ignoredXff.status, 200)
    assert.equal(calls, 1)
  } finally {
    await close(server)
  }
})

test('per-IP and global rate limits return 429 with retry guidance', async () => {
  const search: SearchStub = async params => sampleResult(params.q)
  const perIp = await listen(search, { perIpLimit: 1, globalLimit: 20 })
  try {
    assert.equal((await request(perIp.base, '/api/search?q=first')).status, 200)
    const limited = await request(perIp.base, '/api/search?q=second')
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '60')
    assert.equal((await json(limited)).error, 'rate_limited')
    assert.equal((await request(perIp.base, '/api/search?q=other-ip', { ip: '198.51.100.8' })).status, 200)
  } finally {
    await close(perIp.server)
  }

  const global = await listen(search, { perIpLimit: 20, globalLimit: 1 })
  try {
    assert.equal((await request(global.base, '/api/search?q=first')).status, 200)
    const limited = await request(global.base, '/api/search?q=second', { ip: '198.51.100.8' })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '60')
  } finally {
    await close(global.server)
  }
})

function deferredSearch() {
  let resolveGate!: () => void
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const gate = new Promise<void>(resolve => { resolveGate = resolve })
  const search: SearchStub = async params => {
    markStarted()
    await gate
    return sampleResult(params.q)
  }
  return { search, started, release: resolveGate }
}

test('concurrency limits stay occupied until upstream work resolves, including an aborted client', async () => {
  const firstGate = deferredSearch()
  const first = await listen(firstGate.search, { concurrency: 1, perIpConcurrency: 1 })
  try {
    const firstRequest = request(first.base, '/api/search?q=first')
    await firstGate.started
    const busy = await request(first.base, '/api/search?q=second')
    assert.equal(busy.status, 429)
    assert.equal((await json(busy)).error, 'busy')
    firstGate.release()
    assert.equal((await firstRequest).status, 200)
  } finally {
    await close(first.server)
  }

  const abandonedGate = deferredSearch()
  const abandoned = await listen(abandonedGate.search, { concurrency: 1, perIpConcurrency: 1 })
  try {
    const controller = new AbortController()
    const abandonedRequest = request(abandoned.base, '/api/search?q=abandoned', { signal: controller.signal }).catch(() => undefined)
    await abandonedGate.started
    controller.abort()
    await new Promise(resolve => setImmediate(resolve))
    const busy = await request(abandoned.base, '/api/search?q=still-busy')
    assert.equal(busy.status, 429)
    assert.equal((await json(busy)).error, 'busy')
    abandonedGate.release()
    await abandonedRequest
  } finally {
    await close(abandoned.server)
  }
})

test('upstream errors are reduced to a public generic response', async () => {
  const search: SearchStub = async () => { throw new Error('private path C:\\secret\\cookie=COOKIE_SECRET') }
  const { server, base } = await listen(search)
  try {
    const response = await request(base, '/api/search?q=sample')
    assert.equal(response.status, 502)
    const body = await json(response)
    assert.deepEqual(body, { ok: false, error: 'sources_unavailable', message: '搜索源暂时不可用，请稍后重试' })
    assert.doesNotMatch(JSON.stringify(body), /COOKIE_SECRET|secret|private|C:\\/i)
  } finally {
    await close(server)
  }
})

test('public settings reject unsafe or invalid configuration', () => {
  const valid = { PUBLIC_SEARCH_ORIGIN: `https://${HOST}`, PUBLIC_SEARCH_PROXY_TOKEN: TOKEN }
  assert.equal(readSettings(valid).port, 3100)
  for (const origin of ['', 'http://search.example.test', `https://${HOST}/path`, `https://user:pass@${HOST}`]) {
    assert.throws(() => readSettings({ ...valid, PUBLIC_SEARCH_ORIGIN: origin }))
  }
  for (const token of ['', 'short', 'token with spaces', 'a'.repeat(129), 'CHANGE_ME_32_OR_MORE_RANDOM_CHARACTERS']) {
    assert.throws(() => readSettings({ ...valid, PUBLIC_SEARCH_PROXY_TOKEN: token }))
  }
  for (const [name, value] of [['PUBLIC_SEARCH_PORT', '0'], ['PUBLIC_SEARCH_PORT', '65536'], ['PUBLIC_SEARCH_IP_LIMIT', '1.5'], ['PUBLIC_SEARCH_GLOBAL_LIMIT', '-1'], ['PUBLIC_SEARCH_CONCURRENCY', 'NaN'], ['PUBLIC_SEARCH_IP_CONCURRENCY', '5']] as const) {
    assert.throws(() => readSettings({ ...valid, [name]: value }), name)
  }
})
