import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { addDownloadTask, registerAllowedDownloadUrl, listDownloadTasks } from '../../server/downloader/downloadService.js'

const base = path.resolve(process.env.RUNNER_TEMP || '.', 'netpan-bt-e2e')
const fixture = JSON.parse(await readFile(path.join(base, 'fixture.json'), 'utf8')) as {
  magnet: string
  filename: string
  sha256: string
  infoHash: string
  size: number
}
const downloadDir = path.join(base, 'downloaded')
await mkdir(downloadDir, { recursive: true })

const executable = path.resolve('resources/aria2/win/aria2c.exe')
const secret = 'netpan-ci-local-test'
process.env.ARIA2_ENABLED = 'true'
process.env.ARIA2_RPC_URL = 'http://127.0.0.1:16829/jsonrpc'
process.env.ARIA2_RPC_SECRET = secret
const child = spawn(executable, [
  '--enable-rpc=true',
  '--rpc-listen-all=false',
  '--rpc-listen-port=16829',
  '--rpc-secret=' + secret,
  '--enable-dht=false',
  '--enable-peer-exchange=true',
  '--listen-port=25253',
  '--seed-time=0',
  '--bt-save-metadata=true',
  '--bt-tracker-connect-timeout=10',
  '--bt-tracker-timeout=10',
  '--log-level=warn'
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-3000) })
child.stdout.on('data', data => { stderr = (stderr + String(data)).slice(-3000) })

try {
  let ready = false
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('aria2 exited: ' + stderr)
    try {
      const response = await fetch(process.env.ARIA2_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'ready', method: 'aria2.getVersion', params: ['token:' + secret]
        })
      })
      const payload = await response.json() as { result?: unknown }
      if (response.ok && payload.result) { ready = true; break }
    } catch { /* process is starting */ }
    await sleep(150)
  }
  assert.ok(ready, 'aria2 RPC never became ready: ' + stderr)

  registerAllowedDownloadUrl(fixture.magnet)
  const added = await addDownloadTask({ url: fixture.magnet, fileName: fixture.filename, dir: downloadDir })
  assert.ok(added.gid)
  let metadataSeen = false
  let actualBytesSeen = false
  let complete = false
  let lastSnapshot = ''
  for (let i = 0; i < 180; i++) {
    const result = await listDownloadTasks()
    for (const task of result.tasks) {
      if (task.infoHash !== fixture.infoHash && task.gid !== added.gid) continue
      if (!task.metadataPending && (task.totalLength || 0) > 0) metadataSeen = true
      if ((task.completedLength || 0) > 0) actualBytesSeen = true
      if (task.status === 'complete' && (task.completedLength || 0) === fixture.size) complete = true
      lastSnapshot = JSON.stringify({
        status: task.status, metadataPending: task.metadataPending,
        completedLength: task.completedLength, totalLength: task.totalLength,
        connections: task.connections, numSeeders: task.numSeeders,
        errorCode: task.errorCode, errorMessage: task.errorMessage
      })
    }
    if (complete) break
    await sleep(500)
  }
  assert.ok(metadataSeen, 'magnet metadata never resolved: ' + lastSnapshot + ' / ' + stderr)
  assert.ok(actualBytesSeen, 'download did not transfer actual bytes: ' + lastSnapshot)
  assert.ok(complete, 'local torrent did not complete: ' + lastSnapshot)
  const bytes = await readFile(path.join(downloadDir, fixture.filename))
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.equal(digest, fixture.sha256)
  console.log('PASS: local synthetic magnet metadata resolved; actual bytes transferred; complete SHA256 matches.')
} finally {
  child.kill()
  delete process.env.ARIA2_ENABLED
  delete process.env.ARIA2_RPC_URL
  delete process.env.ARIA2_RPC_SECRET
}
