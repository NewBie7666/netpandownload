import assert from 'node:assert/strict'
import {
  createGeneralItem, normalizeGeneralCategory, normalizeGeneralSource,
  parseBitSearchJson, parseNyaaRss, parseAcademicXml, searchGeneralMagnets
} from '../../server/services/magnets/generalSearch.js'

const H1 = '0123456789abcdef0123456789abcdef01234567'
const H2 = 'abcdef0123456789abcdef0123456789abcdef01'
const H3 = 'def0123456789abcdef0123456789abcdef01234'
assert.equal(normalizeGeneralCategory('book'), 'book')
assert.equal(normalizeGeneralCategory(), 'all')
assert.equal(normalizeGeneralSource('nyaa'), 'nyaa')
assert.throws(() => normalizeGeneralSource('https://evil.test'), /搜索源/)
assert.throws(() => normalizeGeneralCategory('invalid'), /分类/)
assert.equal(createGeneralItem('bad', 'Foo', 'nyaa', 'Anime'), null)
assert.equal(createGeneralItem(H1, 'Ubuntu Linux', 'bitsearch', 'Software')?.hash, H1)

const bitsearch = {
  success: true,
  results: [
    { infohash: H1.toUpperCase(), title: 'Ubuntu Linux', category: 'Software', size: 1073741824, seeders: 15 },
    { infohash: H2, title: 'Example adult item', category: 'XXX', size: 100, seeders: 999 },
    { infohash: 'incorrect', title: 'Malformed', category: 'Software' }
  ]
}
const parsedBit = parseBitSearchJson(bitsearch)
assert.equal(parsedBit.length, 1)
assert.equal(parsedBit[0].seeders, 15)
assert.equal(parsedBit[0].size, '1.00 GB')
assert.equal(parsedBit[0].hash, H1)

const nyaa = '<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><item>' +
  '<title><![CDATA[Japanese &amp; English title]]></title>' +
  '<nyaa:infoHash>' + H2 + '</nyaa:infoHash><nyaa:size>2.0 GiB</nyaa:size><nyaa:seeders>4</nyaa:seeders>' +
  '</item></channel></rss>'
assert.equal(parseNyaaRss(nyaa)[0].title, 'Japanese & English title')
assert.equal(parseNyaaRss(nyaa)[0].seeders, 4)
assert.equal(parseNyaaRss(nyaa)[0].hash, H2)

const academic = '<rss><channel><item><title><![CDATA[Ubuntu Dataset]]></title>' +
  '<guid>https://academictorrents.com/details/' + H3 + '</guid></item></channel></rss>'
assert.equal(parseAcademicXml(academic).length, 1)
assert.equal(parseAcademicXml(academic)[0].hash, H3)

const originalFetch = globalThis.fetch
const calls: string[] = []
try {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('bitsearch.eu')) return new Response(JSON.stringify(bitsearch), { status: 200 })
    if (url.includes('nyaa.si')) return new Response(nyaa, { status: 200 })
    if (url.includes('academictorrents.com')) return new Response(academic, { status: 200 })
    return new Response('unexpected URL', { status: 500 })
  }) as typeof fetch
  const result = await searchGeneralMagnets('Ubuntu')
  assert.equal(result.items.length, 3)
  assert.deepEqual(result.sources.map((source) => source.ok), [true, true, true])
  assert.ok(result.items.every((item) => item.magnet.startsWith('magnet:?xt=urn:btih:')))
  assert.equal(calls.length, 3)
  const cached = await searchGeneralMagnets(' ubuntu ')
  assert.equal(cached.items.length, 3)
  assert.equal(calls.length, 3)

  // Partial provider failure should not turn the entire search into an error.
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes('nyaa.si')) throw new Error('source temporarily unavailable')
    return new Response(JSON.stringify(bitsearch), { status: 200 })
  }) as typeof fetch
  const partial = await searchGeneralMagnets('Different Query', 'all', 'bitsearch')
  assert.equal(partial.items.length, 1)
  assert.equal(partial.sources.length, 1)

  await assert.rejects(searchGeneralMagnets('New query', 'all', 'nyaa'), /全部搜索源不可用/)
  await assert.rejects(searchGeneralMagnets('book', 'book', 'nyaa'), /不支持/)
} finally {
  globalThis.fetch = originalFetch
}
console.log('general magnet search tests passed')
