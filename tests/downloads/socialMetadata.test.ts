import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSocialPostHtml, parseSocialYtdlpJson } from '../../server/providers/social/metadataParser.js'

const douyinVideo = 'http://v3.douyinvod.com/video/aweme.mp4?x-sign=a%2Bb'
const douyinCover = 'https://p3.douyincdn.com/cover/cover.jpg?x=1'
const xhsImage1 = 'https://sns-img-qc.xhscdn.com/1/a.jpg?sign=a'
const xhsImage2 = 'http://sns-img-qc.xhscdn.com/1/b.webp?sign=b'
const xhsVideo = 'https://sns-video-bd.xhscdn.com/1/video.mp4?token=t'

test('parses matching Douyin aweme video and prefers video over cover images', () => {
  const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: { videoInfoRes: { item_list: [
      { aweme_id: 'other', video: { play_addr: { url_list: ['https://v3.douyinvod.com/other.mp4'] } } },
      { aweme_id: 'aweme-1', video: { play_addr: { url_list: [douyinVideo] } }, images: [{ url_list: [douyinCover] }] }
    ] } }
  })};</script>`
  const media = parseSocialPostHtml('douyin', html, 'aweme-1')
  assert.equal(media.length, 1)
  assert.equal(media[0].url, 'https://v3.douyinvod.com/video/aweme.mp4?x-sign=a%2Bb')
  assert.equal(media[0].file.name, 'douyin_aweme-1_01.mp4')
})

test('parses URI encoded Douyin RENDER_DATA image gallery in order', () => {
  const state = encodeURIComponent(JSON.stringify({
    aweme_detail: { aweme_id: 'gallery-1', images: [
      { url_list: ['https://p3.douyinpic.com/one.jpg?sig=1'] },
      { url_list: ['https://p3.douyinpic.com/two.webp?sig=2'] }
    ] }
  }))
  const html = `<script id="RENDER_DATA" type="application/json">${state}</script>`
  const media = parseSocialPostHtml('douyin', html, 'gallery-1')
  assert.deepEqual(media.map((item) => item.url), [
    'https://p3.douyinpic.com/one.jpg?sig=1',
    'https://p3.douyinpic.com/two.webp?sig=2'
  ])
  assert.deepEqual(media.map((item) => item.file.name), [
    'douyin_gallery-1_01.jpg',
    'douyin_gallery-1_02.webp'
  ])
})

test('parses XHS initial state with undefined tokens and trusted video streams', () => {
  const state = `window.__INITIAL_STATE__ = ${JSON.stringify({
    note: { noteDetailMap: { 'note-1': { note: {
      noteId: 'note-1', title: 'newline\\n\\u4e2d', unused: null,
      video: { media: { stream: { h264: [{ masterUrl: xhsVideo, backupUrls: ['https://sns-video-bd.xhscdn.com/1/backup.mp4'] }] }, }, consumer: { originVideoKey: undefined } },
      imageList: [{ urlDefault: 'https://sns-img-qc.xhscdn.com/1/cover.jpg' }]
    } } } }
  }).replace('"originVideoKey":null', '"originVideoKey":undefined')};`
  const media = parseSocialPostHtml('xiaohongshu', `<script>${state}</script>`, 'note-1')
  assert.equal(media.length, 1)
  assert.deepEqual(media.map((item) => item.file.name), ['xiaohongshu_note-1_01.mp4'])
  assert.equal(media[0].url, xhsVideo)
  assert.equal(media.some((item) => item.url.includes('/backup.mp4')), false)
})

test('matches the current Douyin loaderData route shape by exact itemId', () => {
  const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      'video_(id)/page': {
        itemId: 'route-1',
        query: { titleType: 'default' },
        video: { play_addr: { url_list: ['https://v3.douyinvod.com/route.mp4?sig=route'] } }
      }
    }
  })};</script>`
  const media = parseSocialPostHtml('douyin', html, 'route-1')
  assert.equal(media.length, 1)
  assert.equal(media[0].url, 'https://v3.douyinvod.com/route.mp4?sig=route')
  assert.throws(() => parseSocialPostHtml('douyin', html, 'other-route'))
})

test('parses XHS infoList image gallery and optional live-photo videos', () => {
  const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    note: { noteDetailMap: { 'note-2': { note: {
      noteId: 'note-2', infoList: [
        { imageSceneWB_DFT: { url: xhsImage1 }, video: { url: 'https://sns-video-bd.xhscdn.com/1/live.mp4' } },
        { urlPre: xhsImage2 }
      ]
    } } } }
  })};</script>`
  const media = parseSocialPostHtml('xiaohongshu', html, 'note-2')
  assert.deepEqual(media.map((item) => item.file.name), [
    'xiaohongshu_note-2_01.jpg',
    'xiaohongshu_note-2_02.mp4',
    'xiaohongshu_note-2_03.webp'
  ])
})

test('keeps XHS photo galleries with normal video placeholders and nested infoList', () => {
  const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    note: { noteDetailMap: { 'photo-note': { note: {
      noteId: 'photo-note', video: { type: 'normal' }, imageList: [{ infoList: [
        { imageSceneWB_DFT: { url: 'https://sns-img-qc.xhscdn.com/1/nested-photo.jpg' } }
      ] }]
    } } } }
  })};</script>`
  const media = parseSocialPostHtml('xiaohongshu', html, 'photo-note')
  assert.equal(media.length, 1)
  assert.equal(media[0].file.name, 'xiaohongshu_photo-note_01.jpg')
})

test('does not fall back to an XHS cover when the post is declared video but has no media', () => {
  const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    note: { noteDetailMap: { 'empty-video': { note: {
      noteId: 'empty-video', type: 'video', video: {}, imageList: [{ urlDefault: 'https://sns-img-qc.xhscdn.com/1/cover.jpg' }]
    } } } }
  })};</script>`
  assert.throws(() => parseSocialPostHtml('xiaohongshu', html, 'empty-video'))
})

test('keeps Douyin image posts with aweme_type 68 and empty video placeholders', () => {
  const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
    aweme_detail: { aweme_id: 'photo-aweme', aweme_type: 68, video: {}, images: [
      { url_list: ['https://p3.douyinpic.com/photo.jpg'] }
    ] }
  })};</script>`
  const media = parseSocialPostHtml('douyin', html, 'photo-aweme')
  assert.equal(media.length, 1)
  assert.equal(media[0].file.name, 'douyin_photo-aweme_01.jpg')
})

test('does not fall back to a Douyin cover when the post is declared video but has no media', () => {
  const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
    aweme_detail: { aweme_id: 'empty-aweme', aweme_type: 0, video: {}, images: [
      { url_list: ['https://p3.douyinpic.com/cover.jpg'] }
    ] }
  })};</script>`
  assert.throws(() => parseSocialPostHtml('douyin', html, 'empty-aweme'))
})

test('yt-dlp requires exact id and progressive direct audio/video formats', () => {
  const json = JSON.stringify({
    id: 'yd-1',
    formats: [
      { format_id: '137', url: 'https://v3.douyinvod.com/video/dash.mp4', ext: 'mp4', vcodec: 'h264', acodec: 'none', protocol: 'https' },
      { format_id: '18', url: douyinVideo, ext: 'mp4', vcodec: 'h264', acodec: 'aac', protocol: 'https', filesize: 1234 },
      { format_id: 'hls', url: 'https://v3.douyinvod.com/video/live.m3u8', ext: 'mp4', vcodec: 'h264', acodec: 'aac', protocol: 'm3u8_native' }
    ]
  })
  const media = parseSocialYtdlpJson('douyin', json, 'yd-1')
  assert.equal(media.length, 1)
  assert.equal(media[0].file.size, 1234)
  assert.throws(() => parseSocialYtdlpJson('douyin', json, 'wrong-id'), /未解析出可用的媒体/)
  assert.throws(() => parseSocialYtdlpJson('douyin', JSON.stringify({ id: 'yd-1', _type: 'playlist', entries: [] }), 'yd-1'))
})

test('rejects unsafe media hosts, credentials, ports, and non-media URLs', () => {
  const html = `<script>window._ROUTER_DATA = ${JSON.stringify({ aweme_detail: {
    aweme_id: 'unsafe', video: { play_addr: { url_list: [
      'https://douyinvod.com.evil.test/a.mp4',
      'https://user:pass@v3.douyinvod.com/a.mp4',
      'https://v3.douyinvod.com:443/a.mp4',
      'javascript:process.exit(1)'
    ] } }
  } })};</script>`
  assert.throws(() => parseSocialPostHtml('douyin', html, 'unsafe'), /未解析出可用的媒体/)
})

test('does not execute JavaScript and rejects id mismatch, traversal, and no-media pages', () => {
  const html = `<script>window._ROUTER_DATA = {"aweme_id":"other","video":{"play_addr":{"url_list":["https://v3.douyinvod.com/x.mp4"]}}}; globalThis.__socialParserPwned = true;</script>`
  assert.throws(() => parseSocialPostHtml('douyin', html, '../../etc/passwd'))
  assert.equal((globalThis as Record<string, unknown>).__socialParserPwned, undefined)
  assert.throws(() => parseSocialPostHtml('douyin', '<script>const x = 1</script>', 'missing'))
  assert.throws(() => parseSocialPostHtml('xiaohongshu', '<script>window.__INITIAL_STATE__ = {"note":{"noteDetailMap":{"n":{"note":{"noteId":"other"}}}}}</script>', 'n'))
})

test('enforces the HTML size limit', () => {
  assert.throws(() => parseSocialPostHtml('douyin', 'x'.repeat(8 * 1024 * 1024 + 1), 'large'))
})
