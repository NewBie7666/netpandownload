import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { validateMagnetInput } from '../../server/downloader/magnetDownload.js'

const validHash = '0123456789abcdef0123456789abcdef01234567'
const sample = 'magnet:?xt=urn:btih:' + validHash + '&dn=Sample&tr=' +
  encodeURIComponent('udp://tracker.opentrackr.org:1337/announce')

test('magnet parser accepts BTIH, keeps public trackers and drops arbitrary options', () => {
  const clean = validateMagnetInput({ magnet: sample + '&evil=http%3A%2F%2Flocalhost' })
  assert.equal(new URL(clean).searchParams.get('xt'), 'urn:btih:' + validHash)
  assert.equal(new URL(clean).searchParams.get('dn'), 'Sample')
  assert.match(clean, /tracker.opentrackr.org/)
  assert.equal(new URL(clean).searchParams.has('evil'), false)
  assert.equal(new URL(validateMagnetInput({ magnet: 'magnet:?xt=urn:btih:' + 'A'.repeat(32) })).searchParams.get('xt'), 'urn:btih:' + 'a'.repeat(32))
})

test('magnet parser rejects malformed, privileged and dangerous tracker inputs', () => {
  for (const value of [
    'http://example.org/test',
    'magnet:?xt=urn:btih:bad',
    'magnet:?xt=urn:btih:' + validHash + '&xt=urn:btih:' + validHash,
    'magnet:?xt=urn:btih:' + validHash + '&tr=' + encodeURIComponent('http://127.0.0.1:8000/announce'),
    'magnet:?xt=urn:btih:' + validHash + '&tr=' + encodeURIComponent('udp://192.168.1.2:6881/announce'),
    'magnet:?xt=urn:btih:' + validHash + '&tr=' + encodeURIComponent('http://host.local/announce'),
    'magnet:?xt=urn:btih:' + validHash + '&tr=' + encodeURIComponent('http://localhost./announce'),
    'magnet:?xt=urn:btih:' + validHash + '&tr=' + encodeURIComponent('http://printer.local./announce'),
    'magnet:?xt=urn:btih:' + validHash + '&tr=' + encodeURIComponent('file:///etc/passwd'),
    'magnet:?xt=urn:btih:' + validHash + '&dn=illegal\nname',
    'magnet:?xt=urn:btih:' + validHash + '&dn=' + 'X'.repeat(300)
  ]) assert.throws(() => validateMagnetInput({ magnet: value }))
  assert.throws(() => validateMagnetInput({ magnet: 123 }))
})

test('magnet add, multi-file status and per-file handoff use the existing aria2 RPC', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'netpan-magnet-'))
  const first = path.join(root, 'video1.mp4')
  const second = path.join(root, 'video2.mp4')
  await writeFile(first, 'one')
  await writeFile(second, 'two-2')
  const gid = '0123456789abcdef'
  const requests: Array<{ method: string, params: unknown[] }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const part of req) chunks.push(Buffer.from(part))
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: string, method: string, params: unknown[] }
    requests.push(rpc)
    res.setHeader('Content-Type', 'application/json')
    const result = rpc.method === 'aria2.addUri' ? gid : {
      gid, status: 'complete', infoHash: validHash, bittorrent: { info: { name: 'Example set' } },
      totalLength: '8', completedLength: '8',
      files: [
        { index: '1', path: first, length: '3', completedLength: '3', selected: 'true' },
        { index: '2', path: second, length: '5', completedLength: '5', selected: 'true' }
      ]
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('server address invalid')
    Object.assign(process.env, {
      ARIA2_ENABLED: 'true',
      ARIA2_RPC_URL: 'http://127.0.0.1:' + address.port + '/jsonrpc',
      ARIA2_RPC_SECRET: 'test-secret',
      NETPAN_PRIVATE_WEB: 'true',
      NETPAN_DOWNLOAD_DIR: root,
      NETPAN_MIN_FREE_BYTES: '0'
    })
    const { addMagnetDownloadTask, getDownloadTaskStatus, openCompletedDownloadFile, removeDownloadTask } =
      await import('../../server/downloader/downloadService.js')
    assert.deepEqual(await addMagnetDownloadTask({ magnet: sample }), { gid })
    assert.equal(requests[0].method, 'aria2.addUri')
    const params = requests[0].params as [string, [string], Record<string, string>]
    assert.equal(params[0], 'token:test-secret')
    assert.equal(params[1].length, 1)
    assert.match(params[1][0], /^magnet:\?xt=/)
    assert.equal(params[2].dir, root)
    assert.equal(params[2]['seed-time'], '0')
    assert.equal(params[2]['follow-torrent'], 'true')
    const status = await getDownloadTaskStatus(gid)
    assert.equal(status.isTorrent, true)
    assert.equal(status.fileName, 'Example set')
    assert.deepEqual(status.files?.map((file) => file.name), ['video1.mp4', 'video2.mp4'])
    await assert.rejects(openCompletedDownloadFile(gid), /多文件任务/)
    const file = await openCompletedDownloadFile(gid, '2')
    assert.equal(file.size, 5)
    assert.equal(file.name, 'video2.mp4')
    await file.handle.close()
    await assert.rejects(openCompletedDownloadFile(gid, '0'), /文件编号/)
    await assert.rejects(removeDownloadTask(gid, { deleteFile: true }), /不支持/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
