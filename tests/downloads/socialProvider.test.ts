import assert from 'node:assert/strict'
import test from 'node:test'
import { extractSocialSource, isSocialInput } from '../../shared/socialLinks.js'
import { normalizeSocialPageUrl } from '../../server/providers/social/source.js'
import { extractSocialPost } from '../../server/providers/social/extractor.js'
import { createSocialProvider } from '../../server/providers/socialProvider.js'
import type { SocialPlatform, SocialPost } from '../../server/providers/social/types.js'
import type { QuarkFile } from '../../shared/types.js'

const douyinId = '1234567890123456789'
const xhsId = '0123456789abcdef01234567'
const douyinShort = 'https://v.douyin.com/AbC12_/'
const douyinCanonical = `https://www.douyin.com/video/${douyinId}?modal_id=${douyinId}&share_source=copy`
const xhsCanonical = `https://www.xiaohongshu.com/explore/${xhsId}?xsec_token=token%2Bwith%2Fquery&xsec_source=pc_share`
const douyinVideo = 'https://v3-web.douyinvod.com/video/aweme.mp4?x-sign=a%2Bb'
const douyinCover = 'https://p3-sign.douyinpic.com/cover/cover.jpg?x=1'
const xhsImage = 'https://sns-img-qc.xhscdn.com/1/cover.jpg?sign=a'
const xhsVideo = 'https://sns-video-bd.xhscdn.com/1/video.mp4?token=t'

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { error?: unknown; code?: unknown }
  if (typeof value.error === 'string') return value.error
  if (typeof value.code === 'string') return value.code
  return undefined
}

function getData<T>(response: { ok: boolean; data?: T | null }): T {
  assert.equal(response.ok, true)
  if (!response.ok || response.data == null) throw new Error('provider response did not contain data')
  return response.data
}

function file(fid: string, name: string, size = 0): QuarkFile {
  return { fid, name, size, isDir: false, createdAt: new Date(0).toISOString() }
}

function socialHtml(platform: SocialPlatform, id: string) {
  if (platform === 'douyin') {
    return `<script>window._ROUTER_DATA = ${JSON.stringify({
      loaderData: { videoInfoRes: { item_list: [{
        aweme_id: id,
        video: { play_addr: { url_list: [douyinVideo] } },
        images: [{ url_list: [douyinCover] }]
      }] } }
    })};</script>`
  }
  return `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    note: { noteDetailMap: { [id]: { note: {
      noteId: id,
      video: { media: { stream: { h264: [{ masterUrl: xhsVideo }] } } },
      imageList: [{ urlDefault: xhsImage }]
    } } } }
  })};</script>`
}

test('extracts copied share text and rejects lookalike hosts', () => {
  const copiedDouyin = `复制打开抖音，看看这个作品 ${douyinShort} 复制此消息`
  const copiedXhs = `复制打开小红书，看看这篇笔记 ${xhsCanonical} 复制`

  const douyin = extractSocialSource(copiedDouyin)
  assert.equal(douyin.platform, 'douyin')
  assert.equal(douyin.url, douyinShort)

  const xhs = extractSocialSource(copiedXhs, 'xiaohongshu')
  assert.equal(xhs.platform, 'xiaohongshu')
  assert.equal(xhs.url, xhsCanonical)
  assert.equal(xhs.id, xhsId)

  assert.equal(isSocialInput(copiedDouyin, 'douyin'), true)
  assert.equal(isSocialInput(copiedXhs, 'xiaohongshu'), true)
  assert.equal(isSocialInput(copiedDouyin, 'xiaohongshu'), false)

  for (const input of [
    'https://www.douyin.com.evil.test/video/1234567890123456789',
    'https://www.xiaohongshu.com.evil.test/explore/0123456789abcdef01234567',
    'https://127.0.0.1/video/1234567890123456789',
    'file:///etc/passwd'
  ]) {
    assert.equal(isSocialInput(input, 'douyin'), false, input)
    assert.equal(isSocialInput(input, 'xiaohongshu'), false, input)
  }
})

test('normalizes trusted page URLs while rejecting off-host, private, and credential redirects', () => {
  assert.equal(
    normalizeSocialPageUrl(`${douyinCanonical}#fragment`, 'douyin'),
    douyinCanonical
  )
  assert.equal(normalizeSocialPageUrl(xhsCanonical, 'xiaohongshu'), xhsCanonical)

  for (const [url, platform] of [
    ['https://www.douyin.com.evil.test/video/1234567890123456789', 'douyin'],
    ['http://127.0.0.1:3000/video/1234567890123456789', 'douyin'],
    ['https://user:pass@www.douyin.com/video/1234567890123456789', 'douyin'],
    ['https://www.xiaohongshu.com/explore/0123456789abcdef01234567', 'douyin'],
    ['https://www.douyin.com/video/1234567890123456789', 'xiaohongshu']
  ] as const) {
    assert.throws(() => normalizeSocialPageUrl(url, platform), (error: unknown) => {
      return errorCode(error) === 'social_redirect_forbidden' || errorCode(error) === 'social_invalid_url'
    }, url)
  }
})

test('follows at most four trusted redirects and preserves the canonical query', async () => {
  const calls: string[] = []
  const responses = new Map([
    [douyinShort, { status: 302, location: douyinCanonical, html: '' }],
    [douyinCanonical, { status: 200, html: socialHtml('douyin', douyinId) }]
  ])

  const post = await extractSocialPost(douyinShort, {
    requestPage: async (url) => {
      calls.push(url)
      const response = responses.get(url)
      if (!response) return { status: 404, html: '' }
      return response
    }
  })

  assert.equal(post.platform, 'douyin')
  assert.equal(post.id, douyinId)
  assert.equal(post.sourceUrl, douyinCanonical)
  assert.deepEqual(post.media.map((item) => item.url), [douyinVideo])
  assert.ok(calls.includes(douyinShort))
  assert.ok(calls.includes(douyinCanonical))

  let redirectCount = 0
  await assert.rejects(
    () => extractSocialPost(douyinShort, {
      requestPage: async () => {
        redirectCount += 1
        return {
          status: 302,
          location: `https://www.douyin.com/video/${douyinId}?hop=${redirectCount}`,
          html: ''
        }
      }
    }),
    (error: unknown) => Boolean(errorCode(error))
  )
  // Four redirects may be followed; the initial request plus the bounded hops
  // is the largest request count a caller should observe.
  assert.ok(redirectCount <= 5, `redirects were not bounded: ${redirectCount}`)
})

test('maps login and upstream HTTP failures to explicit errors and never fabricates media', async () => {
  await assert.rejects(
    () => extractSocialPost(xhsCanonical, {
      requestPage: async () => ({ status: 403, html: '<html>Please log in to continue</html>' })
    }),
    (error: unknown) => ['auth_required', 'blocked_by_upstream'].includes(errorCode(error) || '')
  )
  await assert.rejects(
    () => extractSocialPost(douyinCanonical, {
      requestPage: async () => ({ status: 503, html: '<html>upstream unavailable</html>' })
    }),
    (error: unknown) => ['blocked_by_upstream', 'network_error'].includes(errorCode(error) || '')
  )
  await assert.rejects(
    () => extractSocialPost(douyinCanonical, {
      requestPage: async () => ({ status: 302, location: 'https://evil.example.invalid/video/1', html: '' })
    }),
    (error: unknown) => Boolean(errorCode(error))
  )
  await assert.rejects(
    () => extractSocialPost(douyinCanonical, {
      requestPage: async () => ({ status: 200, html: '<html><body>no media here</body></html>' })
    }),
    (error: unknown) => Boolean(errorCode(error))
  )
})

test('uses an injected yt-dlp result only when it matches the requested post', async () => {
  const json = JSON.stringify({
    id: douyinId,
    formats: [{
      format_id: '18',
      url: douyinVideo,
      ext: 'mp4',
      vcodec: 'h264',
      acodec: 'aac',
      protocol: 'https',
      filesize: 1234
    }]
  })
  const post = await extractSocialPost(douyinCanonical, {
    requestPage: async () => ({ status: 200, html: '<html><body></body></html>' }),
    runYtdlp: async () => json
  })
  assert.equal(post.id, douyinId)
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0]?.url, douyinVideo)
  assert.equal(post.media[0]?.file.size, 1234)

  await assert.rejects(
    () => extractSocialPost(douyinCanonical, {
      requestPage: async () => ({ status: 200, html: '<html><body></body></html>' }),
      runYtdlp: async () => JSON.stringify({ id: '9999999999999999999', formats: [] })
    }),
    (error: unknown) => Boolean(errorCode(error))
  )
})

test('caches post media, requires the selected fid, and ignores client URL metadata', async () => {
  const target = file('social-media-1', 'note.mp4', 1234)
  const post: SocialPost = {
    platform: 'xiaohongshu',
    id: xhsId,
    sourceUrl: xhsCanonical,
    media: [{ file: target, url: xhsVideo }]
  }
  const loaderInputs: string[] = []
  const provider = createSocialProvider('xiaohongshu', async (input) => {
    loaderInputs.push(input)
    return post
  })
  const copied = `复制打开小红书，看看 ${xhsCanonical} 复制`

  assert.equal(provider.id, 'xiaohongshu')
  assert.equal(provider.match(copied), true)
  assert.equal(provider.match('https://xhslink.com/a/AbC12'), true)

  const resolved = getData(await provider.resolveShare({ shareUrl: copied }))
  assert.equal(resolved.shareId, `xiaohongshu:${xhsId}`)
  assert.ok(resolved.stoken)
  assert.equal(resolved.files.length, 1)
  assert.equal(resolved.files[0]?.fid, target.fid)
  assert.equal(loaderInputs.length, 1)
  assert.match(loaderInputs[0] || '', /xsec_token=token%2Bwith%2Fquery/)

  const listed = getData(await provider.list({
    shareId: resolved.shareId,
    stoken: resolved.stoken
  }))
  assert.deepEqual(listed.files, [target])

  const clientFile = {
    ...target,
    // The provider must resolve the URL from its server-side post cache.
    url: 'https://evil.example.invalid/attacker.mp4'
  } as QuarkFile & { url: string }
  const download = getData(await provider.getDownload({
    shareId: resolved.shareId,
    stoken: resolved.stoken,
    file: clientFile
  }))
  assert.equal(download.fid, target.fid)
  assert.equal(download.downloadUrl, xhsVideo)

  const malicious = await provider.getDownload({
    shareId: resolved.shareId,
    stoken: resolved.stoken,
    file: { ...target, fid: 'social-media-not-in-post' }
  })
  assert.equal(malicious.ok, false)

  const unknown = await provider.list({
    shareId: 'xiaohongshu:unknown',
    stoken: resolved.stoken
  })
  assert.equal(unknown.ok, false)
})

test('refreshes stale media from the original signed source before returning a download URL', async () => {
  let now = 0
  const originalFile = file('social-refresh-1', 'refresh.mp4', 1234)
  const refreshedUrl = 'https://sns-video-bd.xhscdn.com/1/refreshed.mp4?token=fresh'
  const first: SocialPost = {
    platform: 'xiaohongshu',
    id: xhsId,
    sourceUrl: xhsCanonical,
    media: [{ file: originalFile, url: xhsVideo }]
  }
  const refreshed: SocialPost = {
    ...first,
    media: [{ file: originalFile, url: refreshedUrl }]
  }
  const loaderInputs: string[] = []
  const provider = createSocialProvider('xiaohongshu', async (input) => {
    loaderInputs.push(input)
    return loaderInputs.length === 1 ? first : refreshed
  }, () => now)

  const resolved = getData(await provider.resolveShare({ shareUrl: xhsCanonical }))
  now = 60_001
  const download = getData(await provider.getDownload({
    shareId: resolved.shareId,
    stoken: resolved.stoken,
    file: originalFile
  }))

  assert.equal(loaderInputs.length, 2)
  assert.equal(loaderInputs[1], xhsCanonical)
  assert.equal(download.downloadUrl, refreshedUrl)
})
