#!/usr/bin/env node

import { createServer, request as requestToUpstream } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const port = Number(process.env.PLAYWRIGHT_PORT || 4173)
const token = 'browser-private-web-token-012345678901234567890123'
const rpcSecret = 'browser-aria2-rpc-secret'
const publicOrigin = 'https://netpan.test'
const completedGid = '0123456789abcdef'
const activeGid = 'fedcba9876543210'
const movieBody = Buffer.from('movie-test-12', 'utf8')

let tempRoot
let rpcServer
let appServer
let proxyServer
let tasks

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function task(pathname, status, totalLength, completedLength, fileName) {
  return {
    gid: pathname,
    status,
    totalLength: String(totalLength),
    completedLength: String(completedLength),
    downloadSpeed: status === 'active' ? '1024' : '0',
    dir: path.join(tempRoot, 'downloads'),
    files: [{
      path: pathname,
      length: String(totalLength),
      completedLength: String(completedLength),
      selected: 'true'
    }],
    fileName
  }
}

function rpcResult(method, params) {
  const supplied = String(params?.[0] || '')
  if (supplied !== `token:${rpcSecret}`) return { error: { code: 401, message: 'unauthorized' } }
  if (method === 'aria2.getVersion') return { result: { version: 'browser-test' } }
  if (method === 'aria2.tellActive') {
    return { result: [...tasks.values()].filter((item) => ['active', 'waiting', 'paused'].includes(item.status)) }
  }
  if (method === 'aria2.tellWaiting') {
    return { result: [...tasks.values()].filter((item) => item.status === 'waiting') }
  }
  if (method === 'aria2.tellStopped') {
    return { result: [...tasks.values()].filter((item) => ['complete', 'error', 'removed'].includes(item.status)) }
  }
  if (method === 'aria2.tellStatus') {
    const gid = String(params?.[1] || '')
    const value = tasks.get(gid)
    return value ? { result: value } : { error: { code: 1, message: 'gid not found' } }
  }
  if (method === 'aria2.pause' || method === 'aria2.unpause') {
    const gid = String(params?.[1] || '')
    const value = tasks.get(gid)
    if (!value) return { error: { code: 1, message: 'gid not found' } }
    value.status = method === 'aria2.pause' ? 'paused' : 'active'
    return { result: gid }
  }
  if (method === 'aria2.remove' || method === 'aria2.removeDownloadResult') {
    const gid = String(params?.[1] || '')
    const value = tasks.get(gid)
    if (value) value.status = 'removed'
    return { result: gid }
  }
  if (method === 'aria2.addUri') {
    const options = params?.[2] || {}
    const gid = `${(tasks.size + 1).toString(16).padStart(16, '0')}`
    const dir = String(options.dir || path.join(tempRoot, 'downloads'))
    const fileName = String(options.out || `browser-${gid}.bin`)
    const filePath = path.join(dir, fileName)
    const value = task(gid, 'waiting', '0', '0', fileName)
    value.dir = dir
    value.files[0].path = filePath
    tasks.set(gid, value)
    return { result: gid }
  }
  return { result: [] }
}

function createRpcServer() {
  return createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    let payload
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      json(res, 400, { error: { code: -32700, message: 'invalid json' } })
      return
    }
    const result = rpcResult(String(payload.method || ''), payload.params)
    json(res, 200, { jsonrpc: '2.0', id: payload.id, ...result })
  })
}

function listen(server, requestedPort) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(requestedPort, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('server address unavailable'))
      else resolve(address.port)
    })
  })
}

async function closeServer(server) {
  if (!server) return
  await new Promise((resolve) => server.close(() => resolve()))
}

function createTrustedProxy(upstreamPort) {
  return createServer((req, res) => {
    const headers = {
      ...req.headers,
      host: `127.0.0.1:${upstreamPort}`,
      authorization: `Bearer ${token}`,
      'x-netpan-token': token,
      origin: publicOrigin
    }
    const upstream = requestToUpstream({
      hostname: '127.0.0.1',
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end('browser fixture upstream unavailable')
    })
    req.pipe(upstream)
  })
}

async function main() {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'netpan-browser-'))
  const downloadDir = path.join(tempRoot, 'downloads')
  const dataDir = path.join(tempRoot, 'data')
  await mkdir(downloadDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(downloadDir, 'movie.mp4'), movieBody)

  const completed = task(completedGid, 'complete', movieBody.length, movieBody.length, 'movie.mp4')
  completed.files[0].path = path.join(downloadDir, 'movie.mp4')
  const active = task(activeGid, 'active', 26, 4, 'unfinished.mp4')
  active.files[0].path = path.join(downloadDir, 'unfinished.mp4')
  tasks = new Map([[completedGid, completed], [activeGid, active]])

  rpcServer = createRpcServer()
  const rpcPort = await listen(rpcServer, 0)
  Object.assign(process.env, {
    QUARK_EMBEDDED_SERVER: 'true',
    QUARK_DESKTOP_ROOT: repoRoot,
    NETPAN_PRIVATE_WEB: 'true',
    NETPAN_WEB_TOKEN: token,
    NETPAN_PUBLIC_ORIGIN: publicOrigin,
    NETPAN_DOWNLOAD_DIR: downloadDir,
    NETPAN_DATA_DIR: dataDir,
    NETPAN_MIN_FREE_BYTES: '0',
    NETPAN_RELEASE_SHA: 'browser-test-release',
    QUARK_MOCK: 'false',
    ARIA2_ENABLED: 'true',
    ARIA2_RPC_URL: `http://127.0.0.1:${rpcPort}/jsonrpc`,
    ARIA2_RPC_SECRET: rpcSecret
  })

  const { startServer } = await import(pathToFileURL(path.join(repoRoot, 'dist-server/server/index.js')).href)
  appServer = await startServer(0)
  const appAddress = appServer.address()
  if (!appAddress || typeof appAddress === 'string') throw new Error('embedded app address unavailable')
  proxyServer = createTrustedProxy(appAddress.port)
  await listen(proxyServer, port)
  console.log(`browser-test-server-ready:${port}`)
}

async function shutdown() {
  await closeServer(proxyServer)
  await closeServer(appServer)
  await closeServer(rpcServer)
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(130)) })
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(143)) })

main().catch(async (error) => {
  console.error(`browser-test-server-failed:${error instanceof Error ? error.message : 'unknown error'}`)
  await shutdown()
  process.exitCode = 1
})
