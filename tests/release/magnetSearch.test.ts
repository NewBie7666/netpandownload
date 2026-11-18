import assert from 'node:assert/strict'
import { normalizeVideoCode, parseMagnetRows } from '../../server/services/magnets/codeSearch.js'
import { normalizeMagnetKeyword, parseMovieCards, searchByKeyword } from '../../server/services/magnets/keywordSearch.js'

assert.equal(normalizeVideoCode(' abp123 '), 'ABP-123')
assert.equal(normalizeVideoCode('ABP-123'), 'ABP-123')
assert.throws(() => normalizeVideoCode('http://example.test'), /番号/)
assert.throws(() => normalizeVideoCode(''), /番号/)
const html = '<table><tr><td><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=test">Sample 1080p 字幕</a></td><td><a>1.8 GB</a></td></tr>' +
  '<tr><td><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567">Duplicate</a></td></tr>' +
  '<tr><td><a href="https://example.com/nope">Not magnet</a></td></tr></table>'
const items = parseMagnetRows(html)
assert.equal(items.length, 1)
assert.equal(items[0].hash, '0123456789abcdef0123456789abcdef01234567')
assert.equal(items[0].size, '1.8 GB')
assert.equal(items[0].isHD, true)
assert.equal(items[0].hasSubtitle, true)
assert.ok(items[0].magnet.includes('&dn=test'))
assert.equal(normalizeMagnetKeyword('  FPRE-24  '), 'FPRE-24')
assert.equal(normalizeMagnetKeyword(' 中文  标题 '), '中文 标题')
assert.throws(() => normalizeMagnetKeyword('a'), /关键词/)
assert.throws(() => normalizeMagnetKeyword('https://example.org'), /关键词/)

const searchHTML = [
  '<a href="/FPRE-249" class="movie-box"><div><img src="cover.jpg"></div><div class="photo-info"><span>测试影片 A<date>FPRE-249</date><date>2026-01-01</date></span></div></a>',
  '<a class="movie-box" href="https://www.javbus.com/FPRE-240"><div></div><div class="photo-info"><span>测试影片 B<date>FPRE-240</date></span></div></a>',
  '<a class="movie-box" href="/FPRE-249"><div class="photo-info"><span>重复影片</span></div></a>',
  '<a class="movie-box" href="https://evil.example/FPRE-241"><div class="photo-info"><span>恶意跳转</span></div></a>',
  '<a class="movie-box" href="/search/FPRE-24"><div class="photo-info"><span>搜索页不是影片</span></div></a>'
].join('')
const movies = parseMovieCards(searchHTML)
assert.equal(movies.length, 2)
assert.deepEqual(movies.map((movie) => movie.code), ['FPRE-249', 'FPRE-240'])
assert.equal(movies[0].title, '测试影片 A')

const originalFetch = globalThis.fetch
const fetchedPaths: string[] = []
try {
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchedPaths.push(String(input))
    return { ok: true, status: 200, text: async () => searchHTML } as Response
  }) as typeof fetch
  const result = await searchByKeyword('FPRE-24')
  assert.equal(result.query, 'FPRE-24')
  assert.deepEqual(result.movies.map((movie) => movie.code), ['FPRE-249', 'FPRE-240'])
  assert.equal(fetchedPaths.length, 2)
  assert.ok(fetchedPaths.every((url) => url.includes('/search/FPRE-24')))
  const cached = await searchByKeyword(' fpre-24 ')
  assert.equal(cached.movies.length, 2)
  assert.equal(fetchedPaths.length, 2)
} finally {
  globalThis.fetch = originalFetch
}

console.log('magnet search tests passed')
