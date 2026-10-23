import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getProvider } from '../../server/providers/registry.js'
import { youtubeProvider } from '../../server/providers/youtubeProvider.js'
import { normalizeYoutubeUrl, isYoutubeVideoUrl, parseYoutubeInfo } from '../../server/providers/youtube/youtubeParser.js'

const good = normalizeYoutubeUrl('https://youtu.be/AbCdEf12345?t=7')
assert.equal(good.shareId, 'youtube:AbCdEf12345')
for (const url of ['https://youtube.com/channel/test','https://youtube.com/playlist?list=ABC',
  'https://youtube.com.evil.net/watch?v=AbCdEf12345','http://localhost/test',
  'https://youtube.com/watch?v=bad']) {
  assert.equal(isYoutubeVideoUrl(url), false, url)
}
const media = 'https://r2---sn-test.googlevideo.com/videoplayback?token=abc'
const info = { id: 'AbCdEf12345', ext: 'mp4', requested_downloads: [{ url: media, ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a' }] }
assert.equal(parseYoutubeInfo(JSON.stringify(info), good).mediaUrl, media)
assert.throws(() => parseYoutubeInfo(JSON.stringify({ id: 'Other123456', requested_downloads: info.requested_downloads }), good))
assert.throws(() => parseYoutubeInfo(JSON.stringify({ id: good.id, requested_downloads: [{ url: 'http://localhost/a', vcodec: 'avc1', acodec: 'mp4a' }] }), good))
const dir = await mkdtemp(path.join(os.tmpdir(), 'netpan-youtube-'))
const executable = path.join(dir, 'yt-dlp')
const old = process.env.YTDLP_PATH
try {
  const output = JSON.stringify(info)
  await writeFile(executable, '#!/usr/bin/env node' + String.fromCharCode(10) + 'process.stdout.write(' + JSON.stringify(output) + ')' + String.fromCharCode(10))
  await chmod(executable, 0o755)
  process.env.YTDLP_PATH = executable
  assert.equal(getProvider('youtube').id, 'youtube')
  const shared = await youtubeProvider.resolveShare({ shareUrl: good.url })
  assert.equal(shared.ok, true)
  if (shared.ok) {
    assert.equal(shared.data.files.length, 1)
    const d = await youtubeProvider.getDownload({
      shareId: shared.data.shareId, stoken: shared.data.stoken, file: shared.data.files[0]
    })
    assert.equal(d.ok, true)
    if (d.ok) assert.equal(d.data.downloadUrl, media)
  }
} finally {
  if (old === undefined) delete process.env.YTDLP_PATH
  else process.env.YTDLP_PATH = old
  await rm(dir, { force: true, recursive: true })
}
console.log('YouTube single-video provider tests passed')
