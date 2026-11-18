import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fixture = await mkdtemp(path.join(tmpdir(), 'netpan-bt-delete-'))
const downloadDir = path.join(fixture, 'downloads')
const outsideFile = path.join(fixture, 'do-not-delete.txt')
await mkdir(downloadDir, { recursive: true })
await writeFile(outsideFile, 'keep me')
const configDir = path.join(fixture, 'data')
await mkdir(configDir)
await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ downloadDir }))
process.env.NETPAN_DATA_DIR = configDir
process.env.ARIA2_ENABLED = 'true'
process.env.ARIA2_RPC_URL = 'http://127.0.0.1:16800/jsonrpc'
process.env.ARIA2_RPC_SECRET = 'fixture-secret'

const { removeDownloadTask } = await import('../../server/downloader/downloadService.js')
const originalFetch = globalThis.fetch
type RecordState = { gid: string; status: string; files: { path: string }[] }
const items = new Map<string, RecordState>()
const rpcMethods: string[] = []
let expectFileBeforeRemove: string | undefined
const transitionCountdown = new Map<string, number>()

globalThis.fetch = (async (_url: RequestInfo | URL, options?: RequestInit) => {
  const body = JSON.parse(String(options?.body || '{}')) as { method: string; params: unknown[] }
  const method = body.method.replace('aria2.', '')
  rpcMethods.push(method)
  const gid = String(body.params[1] || '')
  let result: unknown
  if (method === 'tellStatus') {
    const task = items.get(gid)
    if (!task) return new Response(JSON.stringify({ error: { message: 'GID not found' } }))
    // Simulate asynchronous aria2 removal: RPC acknowledges the command while
    // the transfer remains active until later status polls.
    const left = transitionCountdown.get(gid)
    if (left !== undefined) {
      if (left <= 0) {
        task.status = 'removed'
        transitionCountdown.delete(gid)
      } else {
        transitionCountdown.set(gid, left - 1)
      }
    }
    result = task
  } else if (method === 'remove') {
    const task = items.get(gid)
    assert.ok(task, 'only an existing task can be removed')
    if (expectFileBeforeRemove) await access(expectFileBeforeRemove) // File must still exist.
    if (gid === 'paused-gid') transitionCountdown.set(gid, 2)
    else task.status = 'removed'
    result = gid
  } else if (method === 'removeDownloadResult') {
    const task = items.get(gid)
    assert.ok(task, 'only a known task should be cleaned up')
    assert.ok(['removed', 'complete', 'error'].includes(task.status))
    if (gid === 'http400-gid') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, error: { code: 1, message: 'GID is not yet removable' }
      }), { status: 400 })
    }
    items.delete(gid)
    result = 'OK'
  } else if (method === 'saveSession') {
    result = 'OK'
  } else throw Error('Unexpected RPC method: ' + method)
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
}) as typeof fetch

try {
  // 1. A paused, partially downloaded BT file must be stopped BEFORE unlinking.
  const paused = path.join(downloadDir, 'episode.mp4')
  await writeFile(paused, Buffer.alloc(2048))
  await writeFile(paused + '.aria2', 'state')
  expectFileBeforeRemove = paused
  items.set('paused-gid', { gid: 'paused-gid', status: 'paused', files: [{ path: paused }] })
  const pausedResult = await removeDownloadTask('paused-gid', { deleteFile: true })
  assert.equal(pausedResult.deletedFiles, 2)
  assert.ok(!pausedResult.warning)
  await assert.rejects(access(paused))
  await assert.rejects(access(paused + '.aria2'))
  assert.ok(!items.has('paused-gid'))
  const pausedRpc = rpcMethods.slice(1)
  assert.equal(pausedRpc[0], 'remove')
  assert.equal(pausedRpc[1], 'tellStatus')
  assert.equal(pausedRpc.filter(m => m === 'tellStatus').length, 3)
  assert.ok(pausedRpc.indexOf('removeDownloadResult') > pausedRpc.indexOf('tellStatus'))

  // 2. Completed BT tasks may have multiple individually reported files.
  const nested = path.join(downloadDir, 'Collection')
  await mkdir(nested)
  const movie = path.join(nested, 'movie.mkv')
  const subtitle = path.join(nested, 'subs.srt')
  await writeFile(movie, 'video')
  await writeFile(subtitle, 'captions')
  expectFileBeforeRemove = undefined
  items.set('complete-gid', {
    gid: 'complete-gid', status: 'complete',
    files: [{ path: movie }, { path: subtitle }]
  })
  const completed = await removeDownloadTask('complete-gid', { deleteFile: true })
  assert.equal(completed.deletedFiles, 2)
  await assert.rejects(access(movie))
  await assert.rejects(access(subtitle))
  await access(nested) // Never recursively remove the parent directory.

  // 3. "Delete record only" must preserve the actual file.
  const recordOnlyFile = path.join(downloadDir, 'kept.mp4')
  await writeFile(recordOnlyFile, 'retained')
  items.set('record-gid', { gid: 'record-gid', status: 'active', files: [{ path: recordOnlyFile }] })
  const recordOnly = await removeDownloadTask('record-gid', { deleteFile: false })
  assert.equal(recordOnly.deletedFiles, 0)
  assert.equal((await readFile(recordOnlyFile, 'utf8')), 'retained')
  assert.ok(!items.has('record-gid'))

  // 4. Reject a forged file path before cancelling the task.
  items.set('outside-gid', { gid: 'outside-gid', status: 'paused', files: [{ path: outsideFile }] })
  await assert.rejects(
    () => removeDownloadTask('outside-gid', { deleteFile: true }),
    /只允许删除已配置下载目录/
  )
  assert.ok(items.has('outside-gid'))
  assert.equal(await readFile(outsideFile, 'utf8'), 'keep me')

  // 5. In a metadata-only task no payload may have been created yet.
  items.set('metadata-gid', { gid: 'metadata-gid', status: 'active', files: [] })
  const metadata = await removeDownloadTask('metadata-gid', { deleteFile: true })
  assert.equal(metadata.deletedFiles, 0)
  assert.ok(!items.has('metadata-gid'))

  // 6. Already-missing files should not prevent removing stale records.
  items.set('missing-gid', {
    gid: 'missing-gid', status: 'complete',
    files: [{ path: path.join(downloadDir, 'already-deleted.bin') }]
  })
  const missing = await removeDownloadTask('missing-gid', { deleteFile: true })
  assert.equal(missing.deletedFiles, 0)

  // 7. aria2 can emit HTTP 400 on removeDownloadResult even after the job is
  // stopped; this must show its true RPC message and still delete local files.
  const stubborn = path.join(downloadDir, 'http400.mp4')
  await writeFile(stubborn, 'downloaded bytes')
  items.set('http400-gid', {
    gid: 'http400-gid', status: 'paused', files: [{ path: stubborn }]
  })
  const stubbornResult = await removeDownloadTask('http400-gid', { deleteFile: true })
  assert.equal(stubbornResult.deletedFiles, 1)
  assert.match(stubbornResult.warning || '', /aria2\.removeDownloadResult HTTP 400: GID is not yet removable/)
  await assert.rejects(access(stubborn))
  assert.equal(items.get('http400-gid')?.status, 'removed')

  console.log('PASS: state-transition polling, paused/completed/multi-file BT deletion, RPC 400 partial cleanup and safety.')
} finally {
  globalThis.fetch = originalFetch
  delete process.env.NETPAN_DATA_DIR
  delete process.env.ARIA2_ENABLED
  delete process.env.ARIA2_RPC_URL
  delete process.env.ARIA2_RPC_SECRET
  await rm(fixture, { recursive: true, force: true })
}
