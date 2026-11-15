import assert from 'node:assert/strict'
import { btDownloadOptions, infoHashFromMagnet, normalizeBtih, metadataDiagnostic, PUBLIC_BT_TRACKERS } from '../../server/downloader/btSupport.js'
import { registerAllowedDownloadUrl, addDownloadTask, listDownloadTasks } from '../../server/downloader/downloadService.js'
import { getUnifiedTasks } from '../../server/product/taskAggregator.js'

const hex = '0123456789abcdef0123456789abcdef01234567'
const magnet = 'magnet:?xt=urn:btih:' + hex + '&dn=Legal+test+content'
assert.equal(infoHashFromMagnet(magnet), hex)
assert.equal(normalizeBtih('A'.repeat(32)), '0'.repeat(40))
assert.equal(infoHashFromMagnet('https://example.test/torrent'), '')
assert.equal(infoHashFromMagnet('magnet:?xt=urn:btih:bad'), '')
assert.ok(PUBLIC_BT_TRACKERS.length >= 3)
assert.equal(btDownloadOptions('C:\\Downloads')['bt-save-metadata'], 'true')
assert.ok(btDownloadOptions('C:\\Downloads')['bt-tracker'].includes('tracker.opentrackr.org'))
assert.match(metadataDiagnostic(800, 0, 0), /超过10分钟/)
assert.match(metadataDiagnostic(200, 0, 0), /UDP/)
assert.match(metadataDiagnostic(200, 3, 2), /3个节点/)

process.env.ARIA2_ENABLED = 'true'
process.env.ARIA2_RPC_URL = 'http://127.0.0.1:16800/jsonrpc'
process.env.ARIA2_RPC_SECRET = 'test-secret'
registerAllowedDownloadUrl(magnet)
const originalFetch = globalThis.fetch
const calls: Array<{ method: string; params: unknown[] }> = []
const tasks: Array<Record<string, unknown>> = []
let added = 0

globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body || '{}')) as { method: string; params: unknown[] }
  const method = request.method.replace(/^aria2\./, '')
  calls.push({ method, params: request.params })
  let result: unknown
  if (method === 'tellActive') result = tasks.filter(t => t.status === 'active')
  else if (method === 'tellWaiting') result = tasks.filter(t => t.status === 'waiting')
  else if (method === 'tellStopped') result = tasks.filter(t => t.status === 'complete')
  else if (method === 'addUri') {
    added += 1
    const gid = 'gid-' + added
    const urls = request.params[1] as string[]
    const options = request.params[2] as Record<string, string>
    if (urls[0].startsWith('magnet:')) {
      assert.equal(options['bt-save-metadata'], 'true')
      assert.ok(options['bt-tracker'].includes('tracker.opentrackr.org'))
      assert.ok(!('out' in options), 'BT options must not inherit HTTP output filename')
    } else {
      assert.ok(!('bt-tracker' in options), 'HTTP options must not inherit BT trackers')
    }
    tasks.push({
      gid,
      status: 'active',
      infoHash: urls[0].startsWith('magnet:') ? hex : undefined,
      files: [{ path: urls[0].startsWith('magnet:') ? '[METADATA]Legal test content' : 'sample.bin' }],
      totalLength: '0',
      completedLength: '0',
      downloadSpeed: '0',
      connections: '0',
      numSeeders: '0'
    })
    result = gid
  } else {
    throw new Error('unexpected RPC method: ' + method)
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result }), { status: 200 })
}) as typeof fetch

try {
  const [a, b] = await Promise.all([
    addDownloadTask({ url: magnet, fileName: 'Legal test content' }),
    addDownloadTask({ url: magnet, fileName: 'Legal test content' })
  ])
  assert.equal(a.gid, b.gid)
  assert.equal(a.duplicate, false)
  assert.equal(b.duplicate, true)
  assert.equal(added, 1, 'the same infohash must be added once')
  const pending = (await listDownloadTasks()).tasks[0]
  assert.equal(pending.metadataPending, true)
  assert.equal(pending.isTorrent, true)
  assert.equal(pending.connections, 0)
  assert.equal(pending.numSeeders, 0)
  assert.match(pending.diagnosis || '', /正在获取Torrent元数据/)

  const unified = (await getUnifiedTasks()).find(t => t.gid === a.gid)
  assert.equal(unified?.bt?.metadataPending, true)
  assert.equal(unified?.status, 'running')

  tasks[0].bittorrent = { info: { name: 'Legal test content.bin' } }
  tasks[0].totalLength = '1048576'
  tasks[0].completedLength = '4096'
  tasks[0].connections = '5'
  tasks[0].numSeeders = '2'
  const transferring = (await listDownloadTasks()).tasks[0]
  assert.equal(transferring.metadataPending, false)
  assert.equal(transferring.fileName, 'Legal test content.bin')
  assert.equal(transferring.completedLength, 4096)
  assert.equal(transferring.connections, 5)
  assert.equal(transferring.numSeeders, 2)

  const http = 'https://example.test/public-test.bin'
  registerAllowedDownloadUrl(http)
  const httpTask = await addDownloadTask({ url: http, fileName: 'sample.bin' })
  assert.ok(httpTask.gid)
  assert.equal(added, 2)
  const httpStatus = (await listDownloadTasks()).tasks.find(t => t.gid === httpTask.gid)
  assert.equal(httpStatus?.isTorrent, false)
  assert.ok(calls.some(c => c.method === 'addUri'))
} finally {
  globalThis.fetch = originalFetch
  delete process.env.ARIA2_ENABLED
  delete process.env.ARIA2_RPC_URL
  delete process.env.ARIA2_RPC_SECRET
}

console.log('BT metadata and downloader RPC regression tests passed')
