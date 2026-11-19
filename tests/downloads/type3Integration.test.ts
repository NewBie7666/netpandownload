import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { videoSourceProvider } from '../../server/video-sources/provider.js'
import { normalizeMediaHeaders } from '../../server/video-sources/mediaHeaders.js'

test('Type3 provider executes JavaScript search/detail/player and preserves opaque long IDs and headers', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'netpan-type3-provider-'))
  const previous = process.env.NETPAN_VIDEO_SOURCE_FILE
  process.env.NETPAN_VIDEO_SOURCE_FILE = path.join(scratch, 'sources.json')
  const videoId = 'https://catalog.example.org/video/' + 'a'.repeat(150)
  const rule = `export default {
    search(word,quick,page) { if(word!=='needle'||page!==2)throw Error('search arguments');return {page,pagecount:2,list:[{vod_id:${JSON.stringify(videoId)},vod_name:'Provider fixture'}]}; },
    detail(id) { if(id!==${JSON.stringify(videoId)})throw Error('ID truncated');return {list:[{vod_id:id,vod_name:'Provider fixture',vod_play_from:'opaque',vod_play_url:'Episode$opaque-token'}]}; },
    play(flag,id) { if(flag!=='opaque'||id!=='opaque-token')throw Error('player arguments');return {parse:0,url:'https://1.1.1.1/media.m3u8',header:JSON.stringify({'User-Agent':'Type3-Fixture','Referer':'https://catalog.example.org/'})}; }
  }`
  try {
    await writeFile(process.env.NETPAN_VIDEO_SOURCE_FILE, JSON.stringify([
      { id: 'js-fixture', name: 'Type3 provider fixture', type: 'type3', runtime: 'javascript', enabled: true, apiUrl: 'inline', ext: rule },
      { id: 'bad-fixture', name: 'Invalid result fixture', type: 'type3', runtime: 'javascript', enabled: true, apiUrl: 'inline', ext: 'export default {search(){return "{}";}}' }
    ]))
    const search = await videoSourceProvider.search('js-fixture', 'needle', 2)
    assert.equal(search.items[0].id, videoId)
    const detail = await videoSourceProvider.detail('js-fixture', videoId)
    assert.equal(detail.lines[0].episodes[0].kind, 'resolve')
    const media = await videoSourceProvider.resolve({ sourceId: 'js-fixture', videoId, lineIndex: 0, episodeIndex: 0 })
    assert.equal(media.url, 'https://1.1.1.1/media.m3u8')
    assert.equal(media.kind, 'hls')
    assert.deepEqual(media.headers, { 'User-Agent': 'Type3-Fixture', Referer: 'https://catalog.example.org/' })
    await assert.rejects(() => videoSourceProvider.search('bad-fixture', 'needle'), /没有返回 list|空结果/)
  } finally {
    if (previous === undefined) delete process.env.NETPAN_VIDEO_SOURCE_FILE
    else process.env.NETPAN_VIDEO_SOURCE_FILE = previous
    await rm(scratch, { recursive: true, force: true })
  }
})

test('player header normalization accepts JSON, rejects injection and excludes arbitrary download options', () => {
  assert.deepEqual(normalizeMediaHeaders(''), {})
  assert.deepEqual(normalizeMediaHeaders('{"user-agent":"TVBox","OUT":"evil","cookie":"a=b"}'), { 'User-Agent': 'TVBox', Cookie: 'a=b' })
  assert.throws(() => normalizeMediaHeaders({ Referer: 'x\r\nAuthorization: bad' }), /无效/)
})
