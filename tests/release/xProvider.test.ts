import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectPlatform } from '../../server/router/platformDetector.js'
import { getProvider } from '../../server/providers/registry.js'
import { normalizeXPostUrl, selectXMediaFiles, xProvider } from '../../server/providers/xProvider.js'

function sampleInfo() {
  return {
    entries: [
      {
        title: 'A test post',
        formats: [
          {
            ext: 'mp4',
            protocol: 'm3u8_native',
            url: 'https://video.twimg.com/video/playlist.m3u8',
            height: 1080,
            vcodec: 'avc1.4d401f',
            acodec: 'aac'
          },
          {
            ext: 'mp4',
            protocol: 'https',
            url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/480x270/low.mp4',
            height: 270,
            vcodec: 'avc1.4d401f',
            acodec: 'aac'
          },
          {
            ext: 'mp4',
            protocol: 'https',
            url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/high.mp4',
            height: 720,
            vcodec: 'avc1.4d401f',
            acodec: 'aac'
          }
        ]
      },
      {
        title: 'Second video',
        formats: [
          {
            ext: 'mp4',
            protocol: 'https',
            url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/640x360/second.mp4',
            height: 360,
            vcodec: 'avc1.4d401f',
            acodec: 'aac'
          }
        ]
      }
    ]
  }
}

function testXUrlValidation() {
  for (const input of [
    'https://x.com/example/status/123456789?s=20',
    'https://twitter.com/example/status/123456789',
    'https://mobile.twitter.com/example/status/123456789/video/1',
    'x.com/example/status/123456789',
    'https://x.com/i/status/123456789'
  ]) {
    assert.equal(normalizeXPostUrl(input)?.id, '123456789')
    assert.equal(detectPlatform(input).platform, 'x')
    assert.equal(xProvider.match(input), true)
  }
  for (const input of [
    'https://x.com.evil.example/example/status/123',
    'https://x.com@evil.example/example/status/123',
    'https://x.com/search?q=123',
    'file:///etc/passwd',
    'https://x.com/example/status/not-a-number'
  ]) {
    assert.equal(normalizeXPostUrl(input), null)
    assert.equal(xProvider.match(input), false)
  }
  assert.equal(getProvider('x').capabilities.download, true)
}

function testFormatSelection() {
  const files = selectXMediaFiles(sampleInfo(), '123')
  assert.equal(files.length, 2)
  assert.equal(files[0].file.fid, 'x:123:0')
  assert.ok(files[0].url.endsWith('/high.mp4'))
  assert.ok(files[1].url.endsWith('/second.mp4'))
  assert.ok(files[0].file.name.endsWith('.mp4'))
  assert.equal(selectXMediaFiles({
    formats: [{ ext: 'mp4', protocol: 'm3u8_native', url: 'https://video.twimg.com/playlist.m3u8' }]
  }, '456').length, 0)
  assert.equal(selectXMediaFiles({
    formats: [{ ext: 'mp4', protocol: 'https', url: 'https://evil.example/video.mp4' }]
  }, '456').length, 0)
}

async function testProviderIntegrationWithFakeYtDlp() {
  const directory = await mkdtemp(path.join(tmpdir(), 'netpandownload-x-'))
  const executable = path.join(directory, 'fake-yt-dlp')
  const oldPath = process.env.YTDLP_PATH
  try {
    const jsonOutput = JSON.stringify(sampleInfo())
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(jsonOutput) + ')\n',
      { mode: 0o755 }
    )
    process.env.YTDLP_PATH = executable
    const resolved = await xProvider.resolveShare({ shareUrl: 'https://x.com/example/status/123456789' })
    assert.equal(resolved.kind, 'success')
    if (resolved.kind !== 'success') throw new Error('X resolution failed')
    assert.equal(resolved.data.files.length, 2)
    const download = await xProvider.getDownload({
      shareId: resolved.data.shareId,
      stoken: resolved.data.stoken,
      file: resolved.data.files[0]
    })
    assert.equal(download.kind, 'success')
    if (download.kind !== 'success') throw new Error('X download failed')
    assert.equal(download.data.source, 'direct')
    assert.ok(download.data.downloadUrl?.endsWith('/high.mp4'))
    assert.equal(download.data.name, resolved.data.files[0].name)

    const invalid = await xProvider.getDownload({
      shareId: resolved.data.shareId,
      stoken: resolved.data.stoken,
      file: { ...resolved.data.files[0], fid: 'x:123456789:999' }
    })
    assert.equal(invalid.kind, 'error')
  } finally {
    if (oldPath === undefined) delete process.env.YTDLP_PATH
    else process.env.YTDLP_PATH = oldPath
    await rm(directory, { recursive: true, force: true })
  }
}

testXUrlValidation()
testFormatSelection()
await testProviderIntegrationWithFakeYtDlp()
console.log('X Provider regression tests passed')
