import assert from 'node:assert/strict'
import { fetchBilibiliInitialState } from '../access/index.js'
import { resolveShare } from './index.js'
import { assertEpisodeConsistency, buildResolvedShare } from './utils.js'
import type { YtDlpInfo } from './types.js'

async function testBangumiFlatten() {
  const raw: YtDlpInfo = {
    webpage_url: 'https://www.bilibili.com/bangumi/play/ss1',
    data: {
      episodes: [
        { ep_id: 'ep1', title: 'Episode 1', url: 'https://www.bilibili.com/bangumi/play/ep1' },
        { ep_id: 'ep1-dup', title: 'Duplicate', url: 'https://www.bilibili.com/bangumi/play/ep1' }
      ],
      modules: [
        {
          episodes: [
            { ep_id: 'ep2', title: 'Episode 2', url: 'https://www.bilibili.com/bangumi/play/ep2' }
          ]
        }
      ]
    }
  }

  const resolved = await resolveShare(raw.webpage_url as string, { runYtDlpJson: async () => raw })
  assert.equal(resolved.source, 'bangumi')
  assert.equal(resolved.episodes.length, 2)
  assert.equal(resolved.files.length, 2)
  assert.deepEqual(
    resolved.episodes.map((episode) => episode.index),
    [1, 2]
  )
  assert.deepEqual(
    resolved.episodes.map((episode) => episode.url),
    ['https://www.bilibili.com/bangumi/play/ep1', 'https://www.bilibili.com/bangumi/play/ep2']
  )
}

async function testPlaylistEntries() {
  const raw: YtDlpInfo = {
    webpage_url: 'https://www.bilibili.com/video/BV1234567890',
    entries: [
      {
        id: 'p1',
        title: 'P1',
        webpage_url: 'https://www.bilibili.com/video/BV1234567890?p=1',
        url: 'https://cdn.example/p1.mp4'
      },
      {
        id: 'p2',
        title: 'P2',
        webpage_url: 'https://www.bilibili.com/video/BV1234567890?p=2',
        url: 'https://cdn.example/p2.mp4'
      }
    ]
  }

  const resolved = await resolveShare(raw.webpage_url as string, { runYtDlpJson: async () => raw })
  assert.equal(resolved.source, 'yt-dlp')
  assert.equal(resolved.episodes.length, 2)
  assert.equal(resolved.files.length, 2)
  assert.ok(resolved.episodes.every((episode, index) => episode.index === index + 1))
}

async function testYtDlpFailureFallsBack() {
  const resolved = await resolveShare('https://www.bilibili.com/video/BV1abcdefghi', {
    runYtDlpJson: async () => {
      throw new Error('HTTP Error 412: Precondition Failed')
    }
  })

  assert.equal(resolved.source, 'heuristic')
  assert.equal(resolved.episodes.length, 1)
  assert.equal(resolved.files.length, 1)
  assert.equal(resolved.episodes[0]?.url, 'https://www.bilibili.com/video/BV1abcdefghi')
}

async function testSpaceSearchInitialState() {
  const inputUrl = 'https://space.bilibili.com/1078866473/search?keyword=%E9%87%91%E8%B4%B5%E8%A6%81%E7%95%A5'
  const raw: YtDlpInfo = {
    page: {
      vlist: [
        { bvid: 'BV1space0001', title: '金贵要略 第一讲', duration: 1200 },
        { bvid: 'BV1space0002', title: '金贵要略 第二讲', duration: 1300 },
        { bvid: 'BV1space0001', title: 'duplicate' }
      ]
    }
  }

  const resolved = await resolveShare(inputUrl, {
    runYtDlpJson: async () => {
      throw new Error('yt-dlp unsupported')
    },
    fetchInitialStateJson: async () => raw
  })

  assert.equal(resolved.source, 'space-search')
  assert.equal(resolved.episodes.length, 2)
  assert.deepEqual(
    resolved.episodes.map((episode) => episode.url),
    ['https://www.bilibili.com/video/BV1space0001', 'https://www.bilibili.com/video/BV1space0002']
  )
}

async function testSpaceSearchDoesNotUseSingleVideoFallback() {
  const inputUrl = 'https://space.bilibili.com/1078866473/search?keyword=%E9%87%91%E8%B4%B5%E8%A6%81%E7%95%A5'

  await assert.rejects(
    () => resolveShare(inputUrl, {
      runYtDlpJson: async () => {
        throw new Error('yt-dlp unsupported')
      },
      fetchInitialStateJson: async () => {
        throw new Error('space search blocked')
      }
    }),
    /space search resolve failed/
  )
}

async function testSpaceSearchFetchesAllPages() {
  const originalFetch = globalThis.fetch
  const pageRequests: number[] = []

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/x/web-interface/nav')) {
      return new Response(JSON.stringify({
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/1234567890abcdef1234567890abcdef.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/abcdef1234567890abcdef1234567890.png'
          }
        }
      }))
    }
    if (url.includes('/x/space/wbi/arc/search')) {
      const parsed = new URL(url)
      const page = Number(parsed.searchParams.get('pn') || '1')
      pageRequests.push(page)
      const offset = (page - 1) * 30
      const remaining = Math.max(0, 65 - offset)
      const length = Math.min(30, remaining)
      return new Response(JSON.stringify({
        code: 0,
        data: {
          page: { count: 65 },
          list: {
            vlist: Array.from({ length }, (_, index) => ({
              bvid: `BVspace${String(offset + index + 1).padStart(4, '0')}`,
              title: `Space video ${offset + index + 1}`
            }))
          }
        }
      }))
    }
    return new Response('<html></html>')
  }) as typeof fetch

  try {
    const raw = await fetchBilibiliInitialState('https://space.bilibili.com/1078866473/search?keyword=test')
    const resolved = await resolveShare('https://space.bilibili.com/1078866473/search?keyword=test', {
      runYtDlpJson: async () => {
        throw new Error('yt-dlp unsupported')
      },
      fetchInitialStateJson: async () => raw
    })

    assert.deepEqual(pageRequests, [1, 2, 3])
    assert.equal(resolved.episodes.length, 65)
    assert.equal(resolved.episodes[64]?.title, 'Space video 65')
  } finally {
    globalThis.fetch = originalFetch
  }
}

function testConsistencyLock() {
  const consistent = buildResolvedShare(
    'https://www.bilibili.com/video/BV1abcdefghi',
    [
      {
        id: 'BV1abcdefghi',
        title: 'BV1abcdefghi',
        url: 'https://www.bilibili.com/video/BV1abcdefghi',
        index: 1
      }
    ],
    'heuristic'
  )
  assert.doesNotThrow(() => assertEpisodeConsistency(consistent))

  assert.throws(
    () => assertEpisodeConsistency({ episodes: consistent.episodes, files: [] }),
    /inconsistent/
  )
}

function testFileEpisodeMapping() {
  const resolved = buildResolvedShare(
    'https://www.bilibili.com/video/BV1abcdefghi',
    [
      {
        id: 'p1',
        title: 'P1',
        url: 'https://www.bilibili.com/video/BV1abcdefghi?p=1',
        index: 1,
        downloadInfo: { url: 'https://cdn.example/p1.mp4' }
      },
      {
        id: 'p2',
        title: 'P2',
        url: 'https://www.bilibili.com/video/BV1abcdefghi?p=2',
        index: 2,
        downloadInfo: { url: 'https://cdn.example/p2.mp4' }
      }
    ],
    'yt-dlp'
  )

  const targetFid = resolved.files[1]?.fid
  const index = resolved.files.findIndex((file) => file.fid === targetFid)
  assert.equal(resolved.episodes[index]?.url, 'https://www.bilibili.com/video/BV1abcdefghi?p=2')
}

await testBangumiFlatten()
await testPlaylistEntries()
await testYtDlpFailureFallsBack()
await testSpaceSearchInitialState()
await testSpaceSearchDoesNotUseSingleVideoFallback()
await testSpaceSearchFetchesAllPages()
testConsistencyLock()
testFileEpisodeMapping()

console.info('bilibili resolver tests passed')
