import assert from 'node:assert/strict'
import { normalizeVideoCode, parseMagnetRows } from '../../server/services/magnets/codeSearch.js'

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
console.log('magnet search tests passed')
