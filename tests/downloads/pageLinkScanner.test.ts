import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractFileLinks, parseExtensionFilter } from '../../server/downloader/pageLinkScanner.js'

test('parses multiple suffixes with comma/Chinese comma/space and removes duplicates', () => {
  assert.deepEqual(parseExtensionFilter('.ZIP，pdf; mp4 .zip'), ['zip', 'pdf', 'mp4'])
  for (const invalid of ['', 'zip,../../etc', 'zip;*', Array.from({ length: 21 }, () => 'zip').join(',')]) {
    assert.throws(() => parseExtensionFilter(invalid))
  }
})

test('scans links in HTML, resolves relative/base, decodes entities, ignores fragments and deduplicates', () => {
  const html = [
    '<base href="/releases/2026/">',
    '<a href="package.zip">ZIP</a>',
    '<a href="../docs/manual.PDF?sig=1&amp;v=2#toc">PDF</a>',
    '<a href="https://cdn.example.org/video.mp4?x=3">Video</a>',
    '<a href="package.zip#other">Duplicated ZIP</a>',
    '<a href="javascript:alert(1)">Skip</a>',
    '<a data-href="notreal.zip" href="not-a-file.html">Skip attribute trap</a>',
    '<a href="//other.example/download.exe">Skip by filter</a>',
    '<a href="wrong.zip.exe">Wrong suffix</a>',
    '<a href="image.jpeg">Wrong extension</a>'
  ].join('\n')
  const result = extractFileLinks(html, 'https://example.org/index.html', ['zip', 'pdf', 'mp4'])
  assert.deepEqual(result.items.map(i => i.fileName), ['package.zip', 'manual.PDF', 'video.mp4'])
  assert.equal(result.items[0].url, 'https://example.org/releases/2026/package.zip')
  assert.equal(result.items[1].url, 'https://example.org/releases/docs/manual.PDF?sig=1&v=2')
  assert.equal(result.items[2].extension, 'mp4')
  assert.equal(result.truncated, false)
})

test('handles URL encoding and rejects encoded slash traversal, unsafe protocols and auth links', () => {
  const html = [
    '<a href="/download/a%20b.zip">Good</a>',
    '<a href="/download/%2e%2e%2fsecret.zip">Bad</a>',
    '<a href="file:///etc/passwd.zip">Bad</a>',
    '<a href="https://user:pass@example.org/secret.zip">Bad</a>'
  ].join('')
  const result = extractFileLinks(html, 'https://example.org/', ['zip'])
  assert.deepEqual(result.items.map(i => i.fileName), ['a b.zip'])
})

test('finds static media src attributes but does not execute scripts', () => {
  const html = '<script>fetch("/hidden.zip")</script><img src="/image.jpg"><video src="/film.MP4"></video><source src="/sound.mp3"><a href="/real.zip">link</a>'
  assert.deepEqual(
    extractFileLinks(html, 'https://example.org', ['zip', 'jpg', 'mp4', 'mp3']).items.map(i => i.fileName),
    ['image.jpg', 'film.MP4', 'sound.mp3', 'real.zip']
  )
})
