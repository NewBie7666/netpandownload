import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(tmpdir(), 'netpan-api-'))
const outside = await mkdtemp(path.join(tmpdir(), 'netpan-api-outside-'))
const safePath = path.join(root, 'movie.mp4')
const outsidePath = path.join(outside, 'secret.txt')
await writeFile(safePath, 'movie-test-123')
await writeFile(outsidePath, 'do-not-serve')
let taskStatus = 'complete'
let taskPath = safePath
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
      files: [{ path: taskPath }]
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
    ARIA2_ENABLED: 'true',
    ARIA2_RPC_URL: 'http://127.0.0.1:' + rpcPort + '/jsonrpc',
    ARIA2_RPC_SECRET: 'local-test-secret'
  })
  const { app } = await import('../../server/index.js')
  appServer = createServer(app)
  const apiPort = await listen(appServer)
  const base = 'http://127.0.0.1:' + apiPort
  const url = base + '/api/downloads/file/0123456789abcdef'
  let resp = await fetch(url)
  assert.equal(resp.status, 200)
  assert.match(resp.headers.get('content-disposition') || '', /attachment/)
  assert.equal(resp.headers.get('content-length'), String('movie-test-123'.length))
  assert.equal(await resp.text(), 'movie-test-123')

  taskStatus = 'active'
  resp = await fetch(url)
  assert.equal(resp.status, 409)

  taskStatus = 'complete'
  taskPath = outsidePath
  resp = await fetch(url)
  assert.equal(resp.status, 403)

  taskPath = safePath
  resp = await fetch(base + '/api/downloads/file/not-a-gid')
  assert.equal(resp.status, 400)

  resp = await fetch(base + '/api/health', { headers: { Origin: 'https://evil.example.org' } })
  assert.equal(resp.status, 403)
  resp = await fetch(base + '/api/health', { headers: { Origin: 'https://netpan.example.org' } })
  assert.equal(resp.status, 200)
} finally {
  if (appServer) await close(appServer)
  await close(mockAria2)
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
console.log('Private web API TestBot passed (download, status, traversal, origin)')
