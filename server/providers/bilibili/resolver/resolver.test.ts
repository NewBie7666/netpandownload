import assert from 'node:assert/strict'
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
testConsistencyLock()
testFileEpisodeMapping()

console.info('bilibili resolver tests passed')
