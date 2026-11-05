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
  const key = randomBytes(16), plain = Buffer.concat([Buffer.from([0x47]), Buffer.alloc(187)])
  const enc = createCipheriv('aes-128-cbc', key, hlsIv(list.segments[0]))
  const encrypted = Buffer.concat([enc.update(plain), enc.final()])
  assert.ok(encrypted.length > plain.length)
  const decoder = createDecipheriv('aes-128-cbc', key, hlsIv(list.segments[0]))
  assert.deepEqual(Buffer.concat([decoder.update(encrypted), decoder.final()]), plain)
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
