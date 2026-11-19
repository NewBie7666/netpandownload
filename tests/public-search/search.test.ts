import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublicApp, type PublicSettings } from '../../public-search/server/app.js'
import { runSearch, validateQuery } from '../../public-search/server/search.js'
import type { SearchTransport } from '../../server/search-core/codeSearch.js'
import { isPublicIPv4, validateSourceUrl } from '../../public-search/server/network.js'
import { proxyRequest } from './http.js'

const hash = '0123456789abcdef0123456789abcdef01234567'
const hash2 = 'abcdef0123456789abcdef0123456789abcdef01'
const calls: string[] = []
const fixture: SearchTransport = async raw => {
  calls.push(raw)
  const url = new URL(raw)
  if (url.hostname === 'bitsearch.eu') return { status: 200, html: JSON.stringify({ success: true, results: [
    { infohash: hash, title: '<script>fixture</script>', size: 1024, seeders: 3 }
  ] }) }
  if (url.hostname === 'nyaa.si') return { status: 200, html: `<rss><item><title>Fixture anime</title><nyaa:infoHash>${hash}</nyaa:infoHash></item></rss>` }
  if (url.hostname === 'academictorrents.com') return { status: 200, html: `<rss><item><title>Fixture data</title><guid>https://academictorrents.com/details/${hash2}</guid></item></rss>` }
  if (url.pathname.includes('/search/')) return { status: 200, html: '<a class="movie-box" href="/TEST-765"><div class="photo-info">Fixture movie</div></a>' }
  if (url.pathname === '/TEST-765') return { status: 200, html: 'var gid=123;var uc=1;' }
  if (url.pathname.startsWith('/ajax/')) return { status: 200, html: `<tr><td><a href="magnet:?xt=urn:btih:${hash}&amp;tr=https://private.test/?token=secret">Fixture 1080p</a></td><td>1 GB</td></tr>` }
  return { status: 404, html: '' }
}

test('real shared adapters preserve general, fuzzy, exact and auto searches through HTTP', async () => {
  const settings: PublicSettings = { origin: 'https://search.example.test', proxyToken: 'a'.repeat(40),
    port: 3100, perIpLimit: 50, globalLimit: 100, concurrency: 4, perIpConcurrency: 2 }
  const app = createPublicApp(settings, params => runSearch(params, fixture))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as { port: number }
  const headers = { host: 'search.example.test', 'x-real-ip': '127.0.0.1', 'x-public-search-token': settings.proxyToken }
  async function search(q: string, mode: string) {
    const response = await proxyRequest(`http://127.0.0.1:${address.port}/api/search?` + new URLSearchParams({ q, mode }), { headers })
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  try {
    const general = await search('Fixture', 'general')
    assert.equal(general.items.length, 2, 'results are deduplicated by hash')
    assert.equal(general.movies.length, 0)
    assert.equal(general.sources.length, 3)
    const beforeCache = calls.length
    await search(' fixture ', 'general')
    assert.equal(calls.length, beforeCache)
    const fuzzy = await search('TEST-76', 'fuzzy')
    assert.equal(fuzzy.movies[0].code, 'TEST-765')
    const exact = await search('test765', 'exact')
    assert.equal(exact.items[0].hash, hash)
    assert.ok(exact.items[0].isHD)
    assert.ok(!exact.items[0].magnet.includes('private.test'))
    assert.ok(!exact.items[0].magnet.includes('secret'))
    const beforeAuto = calls.length
    const autoCode = await search('TEST-765', 'auto')
    assert.equal(autoCode.items.length, 1)
    assert.equal(calls.length, beforeAuto, 'auto recognizes a full code and hits exact cache')
    const auto = await search('Fixture combined', 'auto')
    assert.ok(auto.items.length)
    assert.ok(auto.movies.length)
    assert.equal(auto.sources.length, 4)
    for (const route of ['/api/downloads/tasks', '/api/download-engine/tasks', '/api/providers/download', '/api/quark/download']) {
      const response = await proxyRequest(`http://127.0.0.1:${address.port}${route}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ url: exact.items[0].magnet }) })
      assert.equal(response.status, 404, route)
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('partial upstream failure is retained and private diagnostics are removed', async () => {
  const transport: SearchTransport = async (url, options) => {
    if (url.includes('nyaa.si')) throw new Error('C:/private/.env token=secret')
    return fixture(url, options)
  }
  const result = await runSearch(validateQuery({ q: 'partial fixture', mode: 'general' }), transport)
  assert.ok(result.items.length)
  const failed = result.sources.find(source => source.id === 'nyaa')
  assert.equal(failed?.ok, false)
  assert.ok(!JSON.stringify(result).includes('secret'))
  const unavailable: SearchTransport = async () => { throw new Error('private failure') }
  await assert.rejects(runSearch(validateQuery({ q: 'new unavailable fixture', mode: 'general', source: 'bitsearch' }), unavailable), /搜索源暂时不可用/)
})

test('source network allowlist rejects private addresses and arbitrary destinations', () => {
  for (const url of ['http://www.javbus.com/', 'https://evil.test/', 'https://127.0.0.1/',
    'https://nyaa.si:444/', 'https://user:secret@nyaa.si/', 'https://nyaa.si.evil.test/']) {
    assert.throws(() => validateSourceUrl(url))
  }
  for (const url of ['https://www.javbus.com/TEST-765', 'https://bitsearch.eu/api/v1/search?q=foo', 'https://nyaa.si/?page=rss', 'https://academictorrents.com/database.xml']) {
    assert.equal(validateSourceUrl(url).protocol, 'https:')
  }
  for (const ip of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.1.1',
    '192.168.0.1', '100.64.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicIPv4(ip), false, ip)
  assert.equal(isPublicIPv4('1.1.1.1'), true)
  assert.equal(isPublicIPv4('8.8.8.8'), true)
})
