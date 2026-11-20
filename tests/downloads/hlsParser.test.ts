import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runFfmpeg } from '../../server/hls/hlsTasks.js'
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
  assert.deepEqual(list.tags, ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE', '#EXT-X-KEY', '#EXTINF', '#EXT-X-ENDLIST'])
  const key = randomBytes(16), plain = Buffer.concat([Buffer.from([0x47]), Buffer.alloc(187)])
  const enc = createCipheriv('aes-128-cbc', key, hlsIv(list.segments[0]))
  const encrypted = Buffer.concat([enc.update(plain), enc.final()])
  assert.ok(encrypted.length > plain.length)
  const decoder = createDecipheriv('aes-128-cbc', key, hlsIv(list.segments[0]))
  assert.deepEqual(Buffer.concat([decoder.update(encrypted), decoder.final()]), plain)
})
test('VOD byte ranges support explicit and same-URI implicit offsets', () => {
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-BYTERANGE:100@0\n#EXTINF:4,\nmedia.ts\n#EXT-X-BYTERANGE:80\n#EXTINF:4,\nmedia.ts\n#EXT-X-ENDLIST'
  const list = parseHlsMediaPlaylist(text, 'https://example.com/vod/index.m3u8')
  assert.deepEqual(list.segments.map(segment => segment.byteRange), [
    { length: 100, offset: 0 },
    { length: 80, offset: 100 }
  ])
  assert.equal(list.segments[0].map, undefined)
})

test('fMP4 VOD supports EXT-X-MAP, map ranges and discontinuity timestamps', () => {
  const text = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="32@128"\n#EXTINF:2.5,\npart-1.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:2.5,\npart-2.m4s\n#EXT-X-ENDLIST'
  const list = parseHlsMediaPlaylist(text, 'https://example.com/vod/index.m3u8')
  assert.equal(list.segments.length, 2)
  assert.deepEqual(list.segments[0].map, {
    url: 'https://example.com/vod/init.mp4',
    byteRange: { length: 32, offset: 128 }
  })
  assert.equal(list.segments[0].discontinuity, false)
  assert.equal(list.segments[1].discontinuity, true)
  assert.deepEqual(list.segments.map(segment => segment.sequence), [9, 10])
  assert.ok(list.tags.includes('#EXT-X-MAP'))
  assert.ok(list.tags.includes('#EXT-X-DISCONTINUITY'))
})

test('encrypted fMP4 map requires and snapshots explicit IV', () => {
  const text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000009\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg-1.m4s\n#EXT-X-ENDLIST'
  const list = parseHlsMediaPlaylist(text, 'https://example.com/vod/index.m3u8')
  assert.equal(list.segments[0].keyUrl, 'https://example.com/vod/key.bin')
  assert.equal(list.segments[0].iv, '0x00000000000000000000000000000009')
  assert.deepEqual(list.segments[0].map, {
    url: 'https://example.com/vod/init.mp4',
    keyUrl: 'https://example.com/vod/key.bin',
    iv: '0x00000000000000000000000000000009'
  })
  assert.throws(() => parseHlsMediaPlaylist(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg-1.m4s\n#EXT-X-ENDLIST',
    'https://example.com/vod/index.m3u8'
  ), /EXT-X-MAP.*IV/)
})

test('unsupported live, DRM, malformed range and external audio fail with precise tag names', () => {
  for (const content of [
    '#EXTM3U\n#EXTINF:4,\na.ts',
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXTINF:4,\na.m4s\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-BYTERANGE:100\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-PART-INF:PART-TARGET=1\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST'
  ]) assert.throws(() => parseHlsMediaPlaylist(content, 'https://example.com/index.m3u8'))
  assert.throws(() => parseHlsMediaPlaylist(
    '#EXTM3U\n#EXT-X-BYTERANGE:1@0\n#EXTINF:4,\nhttp://example.com/a.ts\n#EXT-X-BYTERANGE:1\n#EXTINF:4,\nhttps://example.com/b.ts\n#EXT-X-ENDLIST',
    'https://example.com/index.m3u8'
  ), /前一个同 URL/)
  assert.throws(() => selectHlsVariant('#EXTM3U\n#EXT-X-MEDIA:URI="a.m3u8",GROUP-ID="x",TYPE=AUDIO\n#EXT-X-STREAM-INF:BANDWIDTH=100\nx.m3u8', 'https://example.com/'), /EXT-X-MEDIA/)
  assert.throws(() => selectHlsVariant('#EXTM3U\n#EXT-X-MEDIA:URI="v.m3u8",TYPE=VIDEO,GROUP-ID="x"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nx.m3u8', 'https://example.com/'), /外置视频/)
})

test('real MPEG-TS fixture remuxes into playable MP4 entirely offline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hls-remux-fixture-'))
  try {
    const ts = path.join(directory, 'input.ts')
    const mp4 = path.join(directory, 'output.mp4')
    const make = spawnSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=10',
      '-t', '1', '-c:v', 'mpeg2video', '-f', 'mpegts', ts
    ], { encoding: 'utf8', timeout: 15000 })
    assert.equal(make.status, 0, make.stderr || make.error?.message)
    const source = await readFile(ts)
    assert.equal(source[0], 0x47)
    await runFfmpeg(ts, mp4, new AbortController().signal)
    const result = await readFile(mp4)
    assert.ok(result.length > 1000)
    assert.equal(result.subarray(4,8).toString(), 'ftyp')
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', mp4
    ], { encoding: 'utf8', timeout: 15000 })
    assert.equal(probe.status, 0, probe.stderr)
    assert.ok(Number(probe.stdout) > 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
