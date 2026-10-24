import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(tmpdir(), 'netpan-api-'))
const outside = await mkdtemp(path.join(tmpdir(), 'netpan-api-outside-'))
const safePath = path.join(root, 'movie.mp4')
const outsidePath = path.join(outside, 'secret.txt')
await writeFile(safePath, 'movie-test-12')
await writeFile(outsidePath, 'do-not-serve')
let taskStatus = 'complete'
let taskPath = safePath
let taskTotalLength = '13'
let taskCompletedLength = '13'
let fileLength = '13'
let fileCompletedLength = '13'
const webToken = 'test-netpan-web-token-012345678901234567890123'
const authHeaders = (extra: Record<string, string> = {}) => ({
  'X-Netpan-Token': webToken,
  ...extra
})
const mockAria2 = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const part of req) chunks.push(Buffer.from(part))
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(payload.method, 'aria2.tellStatus')
  assert.equal(payload.params[0], 'token:local-test-secret')
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({
    jsonrpc: '2.0', id: payload.id,
    result: {
      gid: '0123456789abcdef', status: taskStatus,
      totalLength: taskTotalLength,
      completedLength: taskCompletedLength,
      files: [{ path: taskPath, length: fileLength, completedLength: fileCompletedLength }]
    }
  }))
})
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('socket address unavailable')
  return addr.port
}
const close = async (server: Server) => { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) }
let appServer: Server | undefined
try {
  const rpcPort = await listen(mockAria2)
  Object.assign(process.env, {
    QUARK_EMBEDDED_SERVER: 'true',
    NETPAN_PRIVATE_WEB: 'true',
    NETPAN_DOWNLOAD_DIR: root,
    NETPAN_DATA_DIR: root,
    NETPAN_PUBLIC_ORIGIN: 'https://netpan.example.org',
    NETPAN_WEB_TOKEN: webToken,
    ARIA2_ENABLED: 'true',
    ARIA2_RPC_URL: 'http://127.0.0.1:' + rpcPort + '/jsonrpc',
    ARIA2_RPC_SECRET: 'local-test-secret'
  })
  const { app } = await import('../../server/index.js')
  appServer = createServer(app)
  const apiPort = await listen(appServer)
  const base = 'http://127.0.0.1:' + apiPort
  const url = base + '/api/downloads/file/0123456789abcdef'
  // Private-web requests fail closed before any aria2 RPC is attempted.
  let resp = await fetch(url)
  assert.equal(resp.status, 401)
  resp = await fetch(url, { headers: { Authorization: `Bearer ${webToken}` } })
  assert.equal(resp.status, 200)
  assert.match(resp.headers.get('content-disposition') || '', /attachment/)
  assert.equal(resp.headers.get('content-length'), String('movie-test-12'.length))
  const body = Buffer.from(await resp.arrayBuffer())
  assert.equal(body.toString('utf8'), 'movie-test-12')
  assert.equal(createHash('sha256').update(body).digest('hex'), 'c56c0e5be99e3c459041d67fc06c2af4ff5bd9641e926133be83687f6be6fbe0')

  taskStatus = 'active'
  resp = await fetch(url, { headers: authHeaders() })
  assert.equal(resp.status, 409)

  taskStatus = 'complete'
  await truncate(safePath, 1)
  resp = await fetch(url, { headers: authHeaders() })
  assert.equal(resp.status, 409)
  await writeFile(safePath, 'movie-test-12')

  taskCompletedLength = '12'
  fileCompletedLength = '12'
  resp = await fetch(url, { headers: authHeaders() })
  assert.equal(resp.status, 409)
  taskCompletedLength = '13'
  fileCompletedLength = '13'

  taskPath = outsidePath
  taskTotalLength = '12'
  taskCompletedLength = '12'
  fileLength = '12'
  fileCompletedLength = '12'
  resp = await fetch(url, { headers: authHeaders() })
  assert.equal(resp.status, 403)

  taskPath = safePath
  taskTotalLength = '13'
  taskCompletedLength = '13'
  fileLength = '13'
  resp = await fetch(base + '/api/downloads/file/not-a-gid', { headers: authHeaders() })
  assert.equal(resp.status, 400)

  resp = await fetch(base + '/api/health', { headers: authHeaders({ Origin: 'https://evil.example.org' }) })
  assert.equal(resp.status, 403)
  resp = await fetch(base + '/api/health', { headers: authHeaders({ Origin: 'https://netpan.example.org' }) })
  assert.equal(resp.status, 200)
  resp = await fetch(base + '/api/health', { headers: { Origin: 'https://netpan.example.org' } })
  assert.equal(resp.status, 401)
} finally {
  if (appServer) await close(appServer)
  await close(mockAria2)
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
console.log('Private web API TestBot passed (download, auth, status, traversal, origin)')
