import { parseCommentedJson } from '../../server/video-sources/jsonCompat.js'
import { parseSourceProxyRoutes, preferIpv4 } from '../../server/video-sources/proxyRoute.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parsePlayLines, parseMacCmsResponse } from '../../server/video-sources/parser.js'
import { validateVideoSourceUrl } from '../../server/video-sources/network.js'
import { addVideoSource, importTvBoxSources, importTvBoxSourcesFromUrl, listVideoSources, removeVideoSource, updateVideoSource } from '../../server/video-sources/store.js'

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

test('TVBox preserves MacCMS controls and counts incomplete Spider entries as invalid', async () => {
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
    assert.equal(imported.total, 4)
    assert.equal(imported.alreadyPresent, 1)
    assert.equal(imported.unsupported, 0)
    assert.equal(imported.invalid, 2)
    assert.equal((await listVideoSources()).length, 2)
    await removeVideoSource(created.id)
    assert.equal((await listVideoSources()).length, 1)
  } finally {
    if (previous === undefined) delete process.env.NETPAN_VIDEO_SOURCE_FILE
    else process.env.NETPAN_VIDEO_SOURCE_FILE = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('TVBox URL importer validates remote URL and rejects Spider entries without a runtime reference', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'video-sources-url-test-'))
  const previous = process.env.NETPAN_VIDEO_SOURCE_FILE
  process.env.NETPAN_VIDEO_SOURCE_FILE = path.join(dir, 'catalog.json')
  try {
    let called = ''
    const fakeFetch = async (url: string) => {
      called = url
      return { sites: [
        { name: 'Fixture MacCMS', type: 1, api: 'https://valid.example.com/api.php/provide/vod/' },
        { name: 'Fixture Spider', type: 3, api: 'csp_Fixture' }
      ] }
    }
    const result = await importTvBoxSourcesFromUrl('https://api.hgyx.vip/hgyx.json', fakeFetch)
    assert.equal(called, 'https://api.hgyx.vip/hgyx.json')
    assert.equal(result.imported, 1)
    assert.equal(result.skipped, 1)
    assert.equal(result.total, 2)
    assert.equal(result.invalid, 1)
    await assert.rejects(() => importTvBoxSourcesFromUrl('http://127.0.0.1/private', fakeFetch))
    await assert.rejects(() => importTvBoxSourcesFromUrl('file:///tmp/private', fakeFetch))
    assert.equal((await listVideoSources()).length, 1)
  } finally {
    if (previous === undefined) delete process.env.NETPAN_VIDEO_SOURCE_FILE
    else process.env.NETPAN_VIDEO_SOURCE_FILE = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('TVBox JSON with line/block comments and trailing commas parses safely without executing code', () => {
  const config = parseCommentedJson(String.raw`{
    // not a valid JSON comment, but common in TVBox configs
    # also a TVBox line comment
    "sites": [
      {"name": "Example", "type": 3, "api": "https://example.org/js/?a=1,b]"}, /* block */
    ],
    "raw": "// keep https://domain.example/file,} in quoted text",
  }`) as { sites: Array<{api: string}>, raw: string }
  assert.equal(config.sites[0].api, 'https://example.org/js/?a=1,b]')
  assert.equal(config.raw, '// keep https://domain.example/file,} in quoted text')
  assert.throws(() => parseCommentedJson('{ "sites": eval("process.exit(1)") }'))
  assert.throws(() => parseCommentedJson('{ "sites": [] /* unfinished'))
})

test('pasted commented TVBox JSON counts unknown formats and incomplete Spider separately', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'video-sources-report-test-'))
  const old = process.env.NETPAN_VIDEO_SOURCE_FILE
  process.env.NETPAN_VIDEO_SOURCE_FILE = path.join(dir, 'sources.json')
  try {
    const config = `{
      # comments are common in TVBox
      "sites": [
        { "name":"源A", "type":1, "api":"https://api.example.org/vod/" },
        { "name":"DRPY", "type":3, "api":"csp_Drpy" },
        { "name":"其他站", "type":0, "api":"https://example.org/other" },
      ]
    }`
    const first = await importTvBoxSources(config)
    assert.equal(first.total, 3)
    assert.equal(first.imported, 1)
    assert.equal(first.unsupported, 1)
    assert.equal(first.invalid, 1)
    assert.equal(first.unsupportedSites.length, 1)
    const second = await importTvBoxSources(config)
    assert.equal(second.imported, 0)
    assert.equal(second.alreadyPresent, 1)
    assert.equal(second.unsupported, 1)
    assert.equal(second.invalid, 1)
    assert.equal(second.skipped, 3)
    assert.equal((await listVideoSources()).length, 1)
  } finally {
    if (old === undefined) delete process.env.NETPAN_VIDEO_SOURCE_FILE
    else process.env.NETPAN_VIDEO_SOURCE_FILE = old
    await rm(dir, { recursive: true, force: true })
  }
})

test('safe system-proxy parser accepts only loopback HTTP CONNECT and explicit DIRECT', () => {
  assert.deepEqual(parseSourceProxyRoutes('DIRECT'), [{ kind: 'direct' }])
  assert.deepEqual(parseSourceProxyRoutes('PROXY 127.0.0.1:7890; DIRECT'), [
    { kind: 'proxy', host: '127.0.0.1', port: 7890 },
    { kind: 'direct' }
  ])
  assert.deepEqual(parseSourceProxyRoutes('PROXY [::1]:8888'), [
    { kind: 'proxy', host: '::1', port: 8888 }
  ])
  assert.throws(() => parseSourceProxyRoutes('PROXY external.example.com:8080'))
  assert.throws(() => parseSourceProxyRoutes('SOCKS5 127.0.0.1:1080'))
  assert.throws(() => parseSourceProxyRoutes('PROXY 127.0.0.1:0'))
  assert.throws(() => parseSourceProxyRoutes('PROXY 127.0.0.1:65536'))
})
test('DNS fallback prioritizes IPv4 without losing validated IPv6 candidates', () => {
  const input = [
    { family: 6, address: '2001:4860:4860::8888' },
    { family: 4, address: '8.8.8.8' },
    { family: 6, address: '2606:4700:4700::1111' }
  ]
  const sorted = preferIpv4(input)
  assert.equal(sorted[0].address, '8.8.8.8')
  assert.equal(sorted.length, 3)
  assert.equal(input[0].family, 6)
})



test('Type3 import preserves 100 distinct csp sites, engine options and relative JS paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'type3-import-'))
  const previous = process.env.NETPAN_VIDEO_SOURCE_FILE
  process.env.NETPAN_VIDEO_SOURCE_FILE = path.join(directory, 'sources.json')
  const config = {
    spider: './plugins/spider.jar;md5;0123456789abcdef0123456789abcdef',
    flags: ['line-a'],
    sites: [
      ...Array.from({ length: 100 }, (_, index) => ({
        key: 'site-' + index, name: 'Source ' + index, type: 3, api: 'csp_Site' + index, ext: { index }
      })),
      { key: 'js', name: 'JS engine', type: '3', api: './engine.js', ext: './rule.js' }
    ]
  }
  try {
    const first = await importTvBoxSourcesFromUrl('https://example.org/config/main.json', async () => config)
    assert.equal(first.imported, 101)
    assert.equal(first.unsupported, 0)
    assert.equal(first.invalid, 0)
    const java = first.sources[0]
    assert.equal(java.type, 'type3')
    assert.equal(java.runtime, 'jvm')
    assert.equal(java.spider, 'https://example.org/config/plugins/spider.jar;md5;0123456789abcdef0123456789abcdef')
    assert.deepEqual(java.ext, { index: 0 })
    assert.deepEqual(java.flags, ['line-a'])
    const js = first.sources.at(-1)!
    assert.equal(js.runtime, 'javascript')
    assert.equal(js.apiUrl, 'https://example.org/config/engine.js')
    assert.equal(js.ext, 'https://example.org/config/rule.js')
    const second = await importTvBoxSourcesFromUrl('https://example.org/config/main.json', async () => config)
    assert.equal(second.imported, 0)
    assert.equal(second.alreadyPresent, 101)
  } finally {
    if (previous === undefined) delete process.env.NETPAN_VIDEO_SOURCE_FILE
    else process.env.NETPAN_VIDEO_SOURCE_FILE = previous
    await rm(directory, { recursive: true, force: true })
  }
})
