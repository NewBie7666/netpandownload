import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserFileLinks, parseBrowserExtensions } from '../../electron/interactivePageLinks.js'

test('filters rendered dialog links, relative urls, and captured direct URLs', () => {
  const result = browserFileLinks('https://prosperopatches.com/PPSA01317', [
    '/some-page',
    'https://cdn.example.com/packages/update.pkg?token=abc',
    'https://cdn.example.com/packages/update.pkg?token=abc#details',
    'https://cdn.example.com/manifest.json',
    'javascript:alert(1)',
    'https://user:pass@example.com/secret.pkg',
    '/files/a%20b.PKG'
  ], parseBrowserExtensions('.pkg,json'))
  assert.deepEqual(result.items.map(v=>v.fileName), ['update.pkg','manifest.json','a b.PKG'])
  assert.equal(result.items[0].extension,'pkg')
  assert.equal(result.truncated, false)
})

test('does not pretend that an interactive modal contains links when none are rendered', () => {
  assert.equal(browserFileLinks('https://example.com', ['javascript:alert(1)', '/patch/details'], ['pkg']).items.length, 0)
})

test('enforces limit and validates requested extensions', () => {
  assert.equal(browserFileLinks('https://example.com', ['/a.pkg','/b.pkg'], ['pkg'], 1).truncated, true)
  assert.throws(()=>parseBrowserExtensions(''))
  assert.throws(()=>parseBrowserExtensions('pkg,../../secret'))
})
