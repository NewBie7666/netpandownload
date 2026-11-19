import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AppError } from '../../server/http.js'
import { stageHlsPlaylist } from '../../server/hls/hlsMedia.js'
import { parseHlsMediaPlaylist, type HlsByteRange } from '../../server/hls/hlsParser.js'
import { runFfmpeg } from '../../server/hls/hlsTasks.js'

const ffmpeg = process.env.NETPAN_FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.NETPAN_FFPROBE_PATH || 'ffprobe'
const base = 'https://cdn.example.test/vod/index.m3u8'
const root = 'https://cdn.example.test/vod/'

function command(program: string, args: string[], timeout = 30_000) {
  const result = spawnSync(program, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'utf8', timeout, windowsHide: true
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || program + ' failed')
  return result
}

function makeTs(directory: string, name: string, color: string, duration = '1.0') {
  const output = path.join(directory, name)
  command(ffmpeg, [
    '-f', 'lavfi', '-i', `color=c=${color}:size=128x96:rate=10`,
    '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000',
    '-t', duration, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'mpeg2video', '-g', '10', '-c:a', 'aac', '-b:a', '96k',
    '-f', 'mpegts', output
  ])
  return output
}

function probe(file: string) {
  const result = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'ffprobe failed')
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  return { text: result.stdout, duration: Number(lines[0]) }
}

function assertDecoded(file: string, minimumFrames: number) {
  const decoded = spawnSync(ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(decoded.status, 0, decoded.stderr || decoded.error?.message || 'FFmpeg decode failed')
  const counted = spawnSync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(counted.status, 0, counted.stderr || counted.error?.message || 'FFprobe frame count failed')
  const frames = Number(counted.stdout.trim())
  assert.ok(Number.isFinite(frames) && frames >= minimumFrames,
    `expected at least ${minimumFrames} decoded video frames, got ${counted.stdout}`)
  return frames
}

type Resource = { data: Buffer, url: string }
function fakeFetcher(resources: Map<string, Buffer>, ranges: Array<{ url: string } & Partial<HlsByteRange>>) {
  return async (url: string, _limit: number, signal?: AbortSignal, _referer?: string,
    range?: HlsByteRange): Promise<Resource> => {
    if (signal?.aborted) throw new AppError('hls_aborted', 'HLS 下载已中止', 409)
    const source = resources.get(url)
    if (!source) throw new Error('unexpected fixture URL: ' + url)
    if (range) {
      ranges.push({ url, ...range })
      assert.ok(Number.isSafeInteger(range.offset) && range.offset >= 0)
      assert.ok(Number.isSafeInteger(range.length) && range.length > 0)
      return { data: source.subarray(range.offset, range.offset + range.length), url }
    }
    return { data: source, url }
  }
}

async function stageAndRemux(manifestText: string, resources: Map<string, Buffer>, directory: string,
  ranges: Array<{ url: string } & Partial<HlsByteRange>> = []) {
  const manifest = parseHlsMediaPlaylist(manifestText, base)
  const local = await stageHlsPlaylist(manifest, directory, root, new AbortController().signal,
    undefined, fakeFetcher(resources, ranges))
  const output = path.join(directory, 'output.mp4')
  await runFfmpeg(local, output, new AbortController().signal)
  return { local, output, text: await readFile(local, 'utf8') }
}

test('materializes discontinuous TS VOD with explicit and implicit byte ranges, then remuxes video and audio', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hls-media-ts-'))
  try {
    const first = await readFile(makeTs(directory, 'first.ts', 'red'))
    const second = await readFile(makeTs(directory, 'second.ts', 'blue'))
    const third = await readFile(makeTs(directory, 'third.ts', 'green'))
    assert.equal(first.length % 188, 0)
    assert.equal(second.length % 188, 0)
    assert.equal(third.length % 188, 0)
    const blob = Buffer.concat([first, second, third])
    const manifestText = [
      '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:100', '#EXT-X-TARGETDURATION:1',
      `#EXT-X-BYTERANGE:${first.length}@0`, '#EXTINF:1.0,', 'blob.ts',
      '#EXT-X-DISCONTINUITY', `#EXT-X-BYTERANGE:${second.length}`, '#EXTINF:1.0,', 'blob.ts',
      `#EXT-X-BYTERANGE:${third.length}`, '#EXTINF:1.0,', 'blob.ts', '#EXT-X-ENDLIST', ''
    ].join('\n')
    const { output, text } = await stageAndRemux(manifestText, new Map([[root + 'blob.ts', blob]]), directory, [])
    assert.match(text, /segment-0\.ts/)
    assert.match(text, /#EXT-X-DISCONTINUITY/)
    assert.doesNotMatch(text, /https?:\/\//)
    const inspected = probe(output)
    assert.ok(inspected.duration > 2.5, inspected.text)
    const audio = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', output], { encoding: 'utf8', windowsHide: true })
    assert.equal(audio.status, 0, audio.stderr)
    assert.equal(audio.stdout.trim(), 'audio')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('decrypts AES-128 TS resources and keeps keys out of the generated local playlist', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hls-media-aes-'))
  try {
    const plainA = await readFile(makeTs(directory, 'a.ts', 'yellow', '0.8'))
    const plainB = await readFile(makeTs(directory, 'b.ts', 'purple', '0.8'))
    const keyA = randomBytes(16), keyB = randomBytes(16)
    const ivA = '0x00000000000000000000000000000011'
    const ivB = '0x00000000000000000000000000000022'
    const encrypt = (data: Buffer, key: Buffer, iv: string) => {
      const cipher = createCipheriv('aes-128-cbc', key, Buffer.from(iv.slice(2), 'hex'))
      return Buffer.concat([cipher.update(data), cipher.final()])
    }
    const manifestText = [
      '#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:7',
      `#EXT-X-KEY:METHOD=AES-128,URI="keys/a.key",IV=${ivA}`,
      '#EXTINF:0.8,', 'a.ts',
      `#EXT-X-KEY:METHOD=AES-128,URI="keys/b.key",IV=${ivB}`,
      '#EXTINF:0.8,', 'b.ts', '#EXT-X-ENDLIST', ''
    ].join('\n')
    const resources = new Map([
      [root + 'a.ts', encrypt(plainA, keyA, ivA)], [root + 'b.ts', encrypt(plainB, keyB, ivB)],
      [root + 'keys/a.key', keyA], [root + 'keys/b.key', keyB]
    ])
    const { output, text } = await stageAndRemux(manifestText, resources, directory)
    assert.doesNotMatch(text, /keys\/|https?:\/\//)
    assert.ok(probe(output).duration > 1.2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('materializes fragmented MP4 with an initialization map and multiple moof fragments', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hls-media-fmp4-'))
  try {
    const source = path.join(directory, 'source.mp4')
    command(ffmpeg, [
      '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'mpeg4', '-c:a', 'aac',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', source
    ])
    const bytes = await readFile(source)
    const boxes: Array<{ type: string, data: Buffer }> = []
    for (let offset = 0; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset)
      assert.ok(size >= 8 && offset + size <= bytes.length)
      boxes.push({ type: bytes.toString('ascii', offset + 4, offset + 8), data: bytes.subarray(offset, offset + size) })
      offset += size
    }
    const init = Buffer.concat(boxes.filter(box => box.type === 'ftyp' || box.type === 'moov').map(box => box.data))
    const fragments: Buffer[] = []
    let pending: Buffer[] = []
    for (const box of boxes) {
      if (box.type === 'moof' && pending.length) { fragments.push(Buffer.concat(pending)); pending = [] }
      if (box.type !== 'ftyp' && box.type !== 'moov') pending.push(box.data)
    }
    if (pending.length) fragments.push(Buffer.concat(pending))
    assert.ok(fragments.length >= 2, 'ffmpeg did not produce multiple fMP4 fragments')
    const manifestText = [
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MAP:URI="init.mp4"',
      ...fragments.map((_, index) => `#EXTINF:0.5,\npart-${index}.m4s`), '#EXT-X-ENDLIST', ''
    ].join('\n')
    const resources = new Map<string, Buffer>([[root + 'init.mp4', init], ...fragments.map((fragment, index) => [root + `part-${index}.m4s`, fragment] as const)])
    const { output, text } = await stageAndRemux(manifestText, resources, directory)
    assert.match(text, /#EXT-X-MAP:URI="init-0\.mp4"/)
    assert.doesNotMatch(text, /part-\d+\.m4s|init\.mp4|https?:\/\//)
    const inspected = probe(output)
    assert.ok(inspected.duration > 0.6, inspected.text)
    const audio = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', output], { encoding: 'utf8', windowsHide: true })
    assert.equal(audio.status, 0, audio.stderr)
    assert.equal(audio.stdout.trim(), 'audio')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('rejects HTML or nested playlists as media and aborts before writing partial files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hls-media-reject-'))
  try {
    const bad = '#EXTM3U\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST\n'
    const manifest = parseHlsMediaPlaylist(bad, base)
    await assert.rejects(() => stageHlsPlaylist(manifest, directory, root, new AbortController().signal,
      undefined, fakeFetcher(new Map([[root + 'part.ts', Buffer.from('<html>not media</html>')]]), []) as never), /MPEG-TS/)
    const nested = parseHlsMediaPlaylist(bad, base)
    await assert.rejects(() => stageHlsPlaylist(nested, directory, root, new AbortController().signal,
      undefined, fakeFetcher(new Map([[root + 'part.ts', Buffer.from('#EXTM3U\n#EXT-X-ENDLIST')]]), []) as never))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => stageHlsPlaylist(manifest, directory, root, controller.signal,
      undefined, fakeFetcher(new Map([[root + 'part.ts', Buffer.alloc(188, 0x47)]]), []) as never), /中止/)
    const files = await readdir(directory)
    assert.deepEqual(files, [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
