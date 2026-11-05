import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { parseHlsMediaPlaylist, selectHlsVariant, hlsIv } from '../../server/hls/hlsParser.js'

test('master variant picks highest bandwidth and resolves relative URL', () => {
  const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhi/index.m3u8\n'
  assert.equal(selectHlsVariant(text, 'https://example.com/master.m3u8'), 'https://example.com/hi/index.m3u8')
})
test('VOD AES-128 playlist parses sequence, key and IV for multiple segments', () => {
  const text = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/k.key"\n#EXTINF:4.0,\nseg1.ts\n#EXTINF:3,\nseg2.ts\n#EXT-X-ENDLIST'
  const list = parseHlsMediaPlaylist(text, 'https://example.com/vod/x/index.m3u8')
  assert.equal(list.segments.length, 2)
  assert.equal(list.segments[0].url, 'https://example.com/vod/x/seg1.ts')
  assert.equal(list.segments[0].keyUrl, 'https://example.com/vod/keys/k.key')
  assert.equal(hlsIv(list.segments[0]).readBigUInt64BE(8), 5n)
  assert.equal(list.duration, 7)
  const key = randomBytes(16), plain = Buffer.concat([Buffer.from([0x47]), Buffer.alloc(187)])
  const enc = createCipheriv('aes-128-cbc', key, hlsIv(list.segments[0]))
  const encrypted = Buffer.concat([enc.update(plain), enc.final()])
  assert.ok(encrypted.length > plain.length)
})
test('unsupported live, DRM, fMP4, byterange and external audio fail closed', () => {
  for (const content of [
    '#EXTM3U\n#EXTINF:4,\na.ts',
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-BYTERANGE:100@0\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST'
  ]) assert.throws(() => parseHlsMediaPlaylist(content, 'https://example.com/index.m3u8'))
  assert.throws(() => selectHlsVariant('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nx.m3u8', 'https://example.com/'))
})
