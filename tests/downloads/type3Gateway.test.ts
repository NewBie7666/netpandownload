import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AppError } from '../../server/http.js'
import { invokeType3 } from '../../server/video-sources/type3.js'
import { shouldUseType3Gateway, type3GatewayMode } from '../../server/video-sources/type3-gateway.js'
import { videoSourceProvider } from '../../server/video-sources/provider.js'
import type { VideoSource } from '../../shared/videoSources.js'

const source: VideoSource = {
  id: 'gateway-fixture', enabled: true, name: 'Gateway fixture', type: 'type3', runtime: 'jvm',
  apiUrl: 'csp_WexAiJianPianGuard', key: 'wex-test', configUrl: 'https://example.org/tvbox.json',
  spider: 'https://example.org/spider.jar;md5;00000000000000000000000000000000',
  ext: { key: 'fixture' }
}
const token = 'a-secure-local-test-token-42'

function setEnv(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('MTplayer Android Gateway: authenticates local requests and completes source search/detail/player', async () => {
  const calls: Array<{ method: string; data: Record<string, any>; authorization: string }> = []
  let localMedia = false
  let rejectAuth = false
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const method = String(req.url || '').split('/').pop() || ''
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>
      calls.push({ method, data, authorization: String(req.headers.authorization || '') })
      res.setHeader('Content-Type', 'application/json')
      if (rejectAuth) {
        res.statusCode = 401
        res.end(JSON.stringify({ message: 'Invalid gateway token' }))
        return
      }
      if (method === 'search') res.end(JSON.stringify({ list: [{ vod_id: 'movie-1', vod_name: 'Gateway movie' }] }))
      else if (method === 'detail') res.end(JSON.stringify({
        list: [{ vod_id: 'movie-1', vod_name: 'Gateway movie', vod_play_from: '线路一', vod_play_url: '第一集$episode-token' }]
      }))
      else if (method === 'player') res.end(JSON.stringify({
        url: localMedia ? 'http://127.0.0.1:9978/media?id=1' : 'https://1.1.1.1/approved.mp4',
        parse: 0, header: { 'User-Agent': 'Android-Gateway-Fixture' }
      }))
      else res.end(JSON.stringify({ class: [] }))
    })
  })
  const scratch = await mkdtemp(path.join(tmpdir(), 'netpan-type3-gateway-'))
  const files = path.join(scratch, 'sources.json')
  const saved = process.env.NETPAN_VIDEO_SOURCE_FILE
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  const restore = setEnv({
    NETPAN_TYPE3_GATEWAY_URL: 'http://127.0.0.1:' + address.port,
    NETPAN_TYPE3_GATEWAY_TOKEN: token,
    NETPAN_TYPE3_GATEWAY_MODE: 'always',
    NETPAN_VIDEO_SOURCE_FILE: files
  })
  try {
    await writeFile(files, JSON.stringify([source]))
    assert.equal(type3GatewayMode(), 'always')
    const search = await videoSourceProvider.search(source.id, 'test')
    assert.equal(search.items[0].id, 'movie-1')
    const detail = await videoSourceProvider.detail(source.id, 'movie-1')
    assert.equal(detail.lines[0].episodes[0].kind, 'resolve')
    const resolved = await videoSourceProvider.resolve({
      sourceId: source.id, videoId: 'movie-1', lineIndex: 0, episodeIndex: 0
    })
    assert.equal(resolved.url, 'https://1.1.1.1/approved.mp4')
    assert.deepEqual(resolved.headers, { 'User-Agent': 'Android-Gateway-Fixture' })
    assert.deepEqual(calls.map(call => call.method), ['search', 'detail', 'detail', 'player'])
    for (const call of calls) {
      assert.equal(call.authorization, 'Bearer ' + token)
      assert.equal(call.data.site.api, source.apiUrl)
      assert.equal(call.data.site.key, source.key)
      assert.equal(call.data.site.jar, source.spider)
      assert.equal(call.data.site.type, 3)
    }
    assert.equal(calls[0].data.keyword, 'test')
    assert.equal(calls[3].data.flag, '线路一')
    assert.equal(calls[3].data.id, 'episode-token')

    localMedia = true
    await assert.rejects(
      () => invokeType3(source, 'play', { id: 'episode-token', flag: '线路一' }),
      (error: unknown) => error instanceof AppError && error.error === 'type3_gateway_media_proxy_required'
    )
    localMedia = false
    rejectAuth = true
    await assert.rejects(
      () => invokeType3(source, 'search', { keyword: 'test' }),
      (error: unknown) => error instanceof AppError &&
        error.error === 'type3_gateway_execution_failed' &&
        !error.message.includes(token)
    )
  } finally {
    restore()
    if (saved === undefined) delete process.env.NETPAN_VIDEO_SOURCE_FILE
    else process.env.NETPAN_VIDEO_SOURCE_FILE = saved
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(scratch, { recursive: true, force: true })
  }
})

test('Gateway dispatch is opt-in, limited to native ABI errors and rejects external token destinations', async () => {
  const restore = setEnv({
    NETPAN_TYPE3_GATEWAY_MODE: 'native',
    NETPAN_TYPE3_GATEWAY_URL: 'http://192.168.1.99:9978',
    NETPAN_TYPE3_GATEWAY_TOKEN: token
  })
  try {
    assert.equal(shouldUseType3Gateway('search', source), false)
    assert.equal(shouldUseType3Gateway('search', source, new AppError('type3_java_native_unsupported', 'native')), true)
    assert.equal(shouldUseType3Gateway('search', source, new AppError('type3_java_failed', 'broken')), false)
    assert.equal(shouldUseType3Gateway('search', { ...source, runtime: 'javascript' }, new AppError('type3_java_native_unsupported', 'native')), false)
    await assert.rejects(() => invokeType3(source, 'search', { keyword: 'test' }).then(() => null).catch(error => {
      // The normal JVM path may be missing in CI; exercise gateway configuration
      // directly instead by selecting explicit mode below.
      throw error
    }))
    process.env.NETPAN_TYPE3_GATEWAY_MODE = 'always'
    await assert.rejects(
      () => invokeType3(source, 'search', { keyword: 'test' }),
      (error: unknown) => error instanceof AppError && error.error === 'type3_gateway_config_invalid'
    )
    process.env.NETPAN_TYPE3_GATEWAY_URL = 'http://127.0.0.1:18777'
    process.env.NETPAN_TYPE3_GATEWAY_TOKEN = 'mtplayer-local'
    await assert.rejects(
      () => invokeType3(source, 'search', { keyword: 'test' }),
      (error: unknown) => error instanceof AppError && error.error === 'type3_gateway_config_invalid'
    )
  } finally { restore() }
})
