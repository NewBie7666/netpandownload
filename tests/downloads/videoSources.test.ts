import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parsePlayLines, parseMacCmsResponse } from '../../server/video-sources/parser.js'
import { validateVideoSourceUrl } from '../../server/video-sources/network.js'
import { addVideoSource, importTvBoxSources, listVideoSources, removeVideoSource, updateVideoSource } from '../../server/video-sources/store.js'

test('MacCMS JSON extracts multiple lines and distinguishes MP4/HLS/scripts', () => {
  const payload = { page: 2, pagecount: 4, list: [{
    vod_id: 12, vod_name: '测试电影', vod_play_from: 'mp4$$$m3u8$$$jx',
    vod_play_url: '第一集$https://cdn.example.com/first.mp4?key=a#第二集$https://cdn.example.com/second.mp4$$$全集$https://cdn.example.com/list.m3u8$$$跳转$javascript:alert(1)'
  }] }
  const result = parseMacCmsResponse(payload)
  assert.equal(result.page, 2)
  assert.equal(result.pageCount, 4)
  assert.equal(result.items[0].id, '12')
  assert.equal(result.items[0].lines[0].episodes[0].kind, 'mp4')
  assert.equal(result.items[0].lines[0].episodes[1].kind, 'mp4')
  assert.equal(result.items[0].lines[1].episodes[0].kind, 'hls')
  assert.equal(result.items[0].lines[2].episodes[0].kind, 'unsupported')
  assert.equal(parsePlayLines('', '').length, 0)
  assert.throws(() => parseMacCmsResponse({ list: 'bad' }))
})

test('Video source URLs block unsafe schemes, embedded credentials, private hosts and ports', () => {
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.1/', 'http://user:pw@example.com/', 'http://example.com:8080/', 'http://[::1]/']) {
    assert.throws(() => validateVideoSourceUrl(url), url)
  }
  assert.equal(validateVideoSourceUrl('https://movies.example.com/api.php').protocol, 'https:')
})

test('TVBox imports only supported MacCMS sources with persistent controls', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'video-sources-test-'))
  const previous = process.env.NETPAN_VIDEO_SOURCE_FILE
  process.env.NETPAN_VIDEO_SOURCE_FILE = path.join(dir, 'catalog.json')
  try {
    const created = await addVideoSource({ name: 'One', apiUrl: 'https://films.example.com/api.php/provide/vod/' })
    assert.equal((await listVideoSources()).length, 1)
    assert.equal((await updateVideoSource(created.id, { enabled: false })).enabled, false)
    const imported = await importTvBoxSources(JSON.stringify({ sites: [
      { name: 'Two', type: 1, api: 'https://two.example.com/api.php/provide/vod/' },
      { name: 'Script', type: 3, api: 'csp_Api' },
      { name: 'Dup', type: 1, api: 'https://films.example.com/api.php/provide/vod/' },
      { name: 'Private', type: 1, api: 'http://127.0.0.1/api' }
    ] }))
    assert.equal(imported.imported, 1)
    assert.equal(imported.skipped, 3)
    assert.equal((await listVideoSources()).length, 2)
    await removeVideoSource(created.id)
    assert.equal((await listVideoSources()).length, 1)
  } finally {
    if (previous === undefined) delete process.env.NETPAN_VIDEO_SOURCE_FILE
    else process.env.NETPAN_VIDEO_SOURCE_FILE = previous
    await rm(dir, { recursive: true, force: true })
  }
})
