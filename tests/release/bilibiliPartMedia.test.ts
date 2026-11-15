import assert from 'node:assert/strict'
import { normalizeBiliEpisodeUrl } from '../../server/providers/bilibili/resolver/utils.js'
import { resolvePlayUrlMedia } from '../../server/providers/bilibili/media/playUrlMedia.js'

const bvid = 'BV1bYcMzdEgS'
const page9 = 'https://www.bilibili.com/video/' + bvid + '/?p=9&spm_id_from=abc'
assert.equal(normalizeBiliEpisodeUrl(page9), 'https://www.bilibili.com/video/' + bvid + '?p=9')

async function testCorrectPartCidFromMetadata() {
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    seen.push(url.href)
    if (url.pathname === '/x/player/playurl') {
      return new Response(JSON.stringify({ code: 0, data: { durl: [
        { url: 'https://cdn.example/part9.mp4' }
      ] } }), { status: 200 })
    }
    throw new Error('unexpected request ' + url)
  }) as typeof fetch
  try {
    const media = await resolvePlayUrlMedia(page9, { bvid, cid: 9009 })
    assert.equal(media, 'https://cdn.example/part9.mp4')
    assert.equal(seen.length, 1)
    assert.equal(new URL(seen[0]).searchParams.get('cid'), '9009')
  } finally {
    globalThis.fetch = original
  }
}

async function testCorrectPartCidFromViewLookup() {
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    seen.push(url.href)
    if (url.pathname === '/x/web-interface/view') {
      return new Response(JSON.stringify({
        code: 0, data: { cid: 1001, pages: Array.from({ length: 12 }, (_, i) => ({ cid: 1001 + i })) }
      }), { status: 200 })
    }
    if (url.pathname === '/x/player/playurl') {
      return new Response(JSON.stringify({ code: 0, data: { durl: [{ url: 'https://cdn.example/part9.mp4' }] } }), { status: 200 })
    }
    throw new Error('unexpected request ' + url)
  }) as typeof fetch
  try {
    const media = await resolvePlayUrlMedia(page9, undefined)
    assert.equal(media, 'https://cdn.example/part9.mp4')
    assert.equal(seen.length, 2)
    assert.equal(new URL(seen[1]).searchParams.get('cid'), '1009')
  } finally {
    globalThis.fetch = original
  }
}

async function testMissingPartDoesNotDownloadPartOne() {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/x/web-interface/view') {
      return new Response(JSON.stringify({ code: 0, data: { cid: 1001, pages: [{ cid: 1001 }] } }), { status: 200 })
    }
    throw new Error('requesting first-page media is forbidden in P9 test')
  }) as typeof fetch
  try {
    await assert.rejects(() => resolvePlayUrlMedia(page9, undefined), /第 9 P 的 cid/)
  } finally {
    globalThis.fetch = original
  }
}

await testCorrectPartCidFromMetadata()
await testCorrectPartCidFromViewLookup()
await testMissingPartDoesNotDownloadPartOne()
console.log('bilibili P9 media selection tests passed')
