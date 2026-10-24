#!/usr/bin/env node

/**
 * Linux CI runner for the private-web HTTP TestBot.
 *
 * It starts a real aria2c JSON-RPC daemon, a throttled local HTTP media
 * fixture, and the compiled Express app in one process. The fixture URL is
 * registered through the same provider URL authorization cache used by the
 * application; production direct-download SSRF checks are never disabled.
 * The CLI TestBot then drives the app through HTTP and verifies the bytes
 * delivered to a browser client.
 */

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtimeRoot = process.env.NETPAN_TEST_RUNTIME_ROOT || repoRoot
const reportPath = path.join(repoRoot, 'reports', 'testbot.json')
const token = 'testbot-private-web-token-0123456789abcdef0123456789'
const origin = 'https://netpan.test'
const rpcSecret = 'testbot-aria2-rpc-secret'
const report = {
  status: 'running',
  platform: process.platform,
  startedAt: new Date().toISOString(),
  checks: [],
  evidence: {}
}

let tempRoot
let mediaServer
let appServer
let aria2Process
let mediaPort
let appPort
let rpcPort

function safeError(error) {
  const message = error instanceof Error ? error.message : 'unknown error'
  return message.replaceAll(token, '[redacted]').replaceAll(rpcSecret, '[redacted]')
}

async function saveReport() {
  await mkdir(path.dirname(reportPath), { recursive: true })
  report.finishedAt = new Date().toISOString()
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function pass(name, details = {}) {
  report.checks.push({ name, status: 'passed', details })
}

function fail(name, error) {
  report.checks.push({ name, status: 'failed', error: safeError(error) })
}

function skip(name, reason) {
  report.checks.push({ name, status: 'skipped', reason })
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('server did not expose a TCP address'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })
}

async function closeServer(server) {
  if (!server) return
  await new Promise((resolve) => server.close(() => resolve()))
}

function fixtureBuffer(size) {
  const result = Buffer.allocUnsafe(size)
  const seed = Buffer.from('netpandownload-testbot-fixture-v1', 'utf8')
  for (let offset = 0; offset < result.length; offset += seed.length) {
    seed.copy(result, offset, 0, Math.min(seed.length, result.length - offset))
  }
  return result
}

function parseRange(value, size) {
  const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value || ''))
  if (!match) return undefined
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || start >= size) return undefined
  const end = Math.min(size - 1, Number.isSafeInteger(requestedEnd) ? requestedEnd : size - 1)
  if (end < start) return undefined
  return { start, end }
}

function createMediaServer() {
  return createServer((req, res) => {
    if (!String(req.url || '').startsWith('/fixture/')) {
      res.statusCode = 404
      res.end()
      return
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    const mode = url.searchParams.get('mode') || 'fast'
    const size = mode === 'slow' ? 32 * 1024 * 1024 : 512 * 1024
    const delayMs = mode === 'slow' ? 35 : 1
    const payload = fixtureBuffer(size)
    const range = parseRange(req.headers.range, payload.length)
    const start = range?.start || 0
    const end = range?.end ?? payload.length - 1
    const length = end - start + 1

    res.statusCode = range ? 206 : 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Length', String(length))
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`)
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    let offset = start
    let timer
    const send = () => {
      if (res.destroyed || res.writableEnded) return
      if (offset > end) {
        res.end()
        return
      }
      const next = Math.min(offset + 64 * 1024, end + 1)
      const accepted = res.write(payload.subarray(offset, next))
      offset = next
      if (offset > end) {
        res.end()
      } else if (accepted) {
        timer = setTimeout(send, delayMs)
      } else {
        res.once('drain', () => { timer = setTimeout(send, delayMs) })
      }
    }
    res.on('close', () => { if (timer) clearTimeout(timer) })
    send()
  })
}

async function startAria2() {
  const binary = process.env.ARIA2C_BIN || 'aria2c'
  const downloadDir = path.join(tempRoot, 'downloads')
  const session = path.join(tempRoot, 'aria2.session')
  await mkdir(downloadDir, { recursive: true })
  await writeFile(session, '', { flag: 'a' })
  rpcPort = await reservePort()
  report.evidence.aria2Binary = binary
  aria2Process = spawn(binary, [
    '--enable-rpc=true',
    '--rpc-listen-all=false',
    '--rpc-listen-port=' + rpcPort,
    '--rpc-secret=' + rpcSecret,
    '--dir=' + downloadDir,
    '--save-session=' + session,
    '--input-file=' + session,
    '--auto-file-renaming=false',
    '--file-allocation=none',
    '--console-log-level=warn',
    '--summary-interval=0',
    '--max-concurrent-downloads=4'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  aria2Process.on('error', () => { /* waitForRpc reports startup failures without exposing command details */ })
  aria2Process.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000) })
  await waitForRpc()
  report.evidence.aria2RpcPort = rpcPort
  if (stderr && /error|failed/i.test(stderr)) report.evidence.aria2Stderr = stderr.replaceAll(rpcSecret, '[redacted]')
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'close').then(() => undefined),
    new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000))
  ])
}

async function reservePort() {
  const server = createServer()
  const port = await listen(server)
  await closeServer(server)
  return port
}

async function aria2Rpc(method, params = []) {
  const response = await fetch(`http://127.0.0.1:${rpcPort}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: [`token:${rpcSecret}`, ...params] })
  })
  if (!response.ok) throw new Error(`aria2 RPC HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.error) throw new Error(`aria2 RPC ${payload.error.code || ''}`)
  return payload.result
}

async function waitForRpc() {
  let last
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await aria2Rpc('aria2.getVersion')
      return
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`aria2 RPC did not become ready: ${safeError(last)}`)
}

async function aria2Add(url, options) {
  return aria2Rpc('aria2.addUri', [[url], options])
}

async function aria2Status(gid) {
  return aria2Rpc('aria2.tellStatus', [gid, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'dir', 'files']])
}

async function waitForStatus(gid, wanted, timeout = 45000) {
  const started = Date.now()
  let latest
  while (Date.now() - started < timeout) {
    latest = await aria2Status(gid)
    if (wanted.includes(latest.status)) return latest
    if (['error', 'removed'].includes(latest.status)) throw new Error(`aria2 task ended in ${latest.status}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`aria2 task did not reach ${wanted.join('/')} (last=${latest?.status || 'unknown'})`)
}

function apiHeaders() {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Netpan-Token': token,
    Origin: origin
  }
}

async function api(pathname, init = {}) {
  const response = await fetch(`http://127.0.0.1:${appPort}${pathname}`, {
    ...init,
    headers: { ...apiHeaders(), ...(init.headers || {}) },
    redirect: 'manual'
  })
  return response
}

async function apiJson(pathname, init = {}) {
  const response = await api(pathname, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok !== true) throw new Error(`API ${pathname} returned HTTP ${response.status}`)
  return payload.result
}

async function addAppTask(url, fileName) {
  const { registerAllowedDownloadUrl } = await import(pathToFileURL(path.join(runtimeRoot, 'dist-server/server/downloader/downloadService.js')).href)
  registerAllowedDownloadUrl(url, Date.now() + 10 * 60 * 1000)
  const result = await apiJson('/api/downloads/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, fileName })
  })
  assert.match(String(result.gid), /^[0-9a-f]{16}$/i)
  return String(result.gid)
}

async function runCliTestBot(appGid, controlledGid, incompleteGid, traversalGid, expectedSha) {
  const child = spawn(process.execPath, [
    path.join(repoRoot, 'scripts/testbot.mjs'),
    '--base-url', `http://127.0.0.1:${appPort}`,
    '--origin', origin,
    '--gid', appGid,
    '--expected-sha256', expectedSha,
    '--active-gid', controlledGid,
    '--incomplete-gid', incompleteGid,
    '--traversal-gid', traversalGid
  ], {
    cwd: repoRoot,
    env: { ...process.env, NETPAN_WEB_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-10000) })
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000) })
  const [code] = await once(child, 'close')
  report.evidence.cliTestBot = {
    exitCode: code,
    stdout: stdout.trim().split(/\r?\n/).filter(Boolean),
    stderr: stderr.trim().split(/\r?\n/).filter(Boolean)
  }
  if (code !== 0) throw new Error('scripts/testbot.mjs returned a failure')
  pass('cli HTTP TestBot', { exitCode: code })
}

async function run() {
  if (process.platform !== 'linux') {
    report.status = 'skipped'
    report.reason = 'The real aria2c runner requires Linux; CI installs aria2 on Ubuntu.'
    skip('linux integration runner', report.reason)
    return
  }

  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'netpan-testbot-'))
  const downloadDir = path.join(tempRoot, 'downloads')
  const dataDir = path.join(tempRoot, 'data')
  const outsideDir = path.join(tempRoot, 'outside')
  await Promise.all([mkdir(downloadDir, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(outsideDir, { recursive: true })])

  mediaServer = createMediaServer()
  mediaPort = await listen(mediaServer)
  const fastUrl = `http://127.0.0.1:${mediaPort}/fixture/app.bin?mode=fast`
  const slowControlUrl = `http://127.0.0.1:${mediaPort}/fixture/control.bin?mode=slow`
  const slowIncompleteUrl = `http://127.0.0.1:${mediaPort}/fixture/incomplete.bin?mode=slow`
  const traversalUrl = `http://127.0.0.1:${mediaPort}/fixture/traversal.bin?mode=fast`
  const appExpectedSha = createHash('sha256').update(fixtureBuffer(512 * 1024)).digest('hex')

  await startAria2()
  process.env.QUARK_EMBEDDED_SERVER = 'true'
  process.env.NETPAN_PRIVATE_WEB = 'true'
  process.env.NETPAN_WEB_TOKEN = token
  process.env.NETPAN_PUBLIC_ORIGIN = origin
  process.env.NETPAN_DOWNLOAD_DIR = downloadDir
  process.env.NETPAN_DATA_DIR = dataDir
  process.env.NETPAN_MIN_FREE_BYTES = '0'
  process.env.NETPAN_RELEASE_SHA = 'testbot-fixture-release'
  process.env.QUARK_MOCK = 'false'
  process.env.ARIA2_ENABLED = 'true'
  process.env.ARIA2_RPC_URL = `http://127.0.0.1:${rpcPort}/jsonrpc`
  process.env.ARIA2_RPC_SECRET = rpcSecret

  report.evidence.runtime = process.env.NETPAN_TEST_RUNTIME_ROOT ? 'verified-linux-release-package' : 'compiled-checkout'
  const { startServer } = await import(pathToFileURL(path.join(runtimeRoot, 'dist-server/server/index.js')).href)
  appServer = await startServer(0)
  const appAddress = appServer.address()
  if (!appAddress || typeof appAddress === 'string') throw new Error('app server did not expose a TCP address')
  appPort = appAddress.port
  report.evidence.appPort = appPort
  report.evidence.mediaPort = mediaPort

  const appGid = await addAppTask(fastUrl, 'testbot-app.bin')
  const controlGid = await aria2Add(slowControlUrl, {
    dir: downloadDir,
    out: 'testbot-control.bin',
    split: '1',
    'max-connection-per-server': '1',
    continue: 'true'
  })
  const incompleteGid = await aria2Add(slowIncompleteUrl, {
    dir: downloadDir,
    out: 'testbot-incomplete.bin',
    split: '1',
    'max-connection-per-server': '1',
    continue: 'true'
  })
  const traversalGid = await aria2Add(traversalUrl, {
    dir: outsideDir,
    out: 'testbot-traversal.bin',
    split: '1',
    'max-connection-per-server': '1'
  })
  report.evidence.gids = { app: appGid, control: controlGid, incomplete: incompleteGid, traversal: traversalGid }

  await waitForStatus(controlGid, ['active', 'waiting'])
  await waitForStatus(incompleteGid, ['active', 'waiting'])
  await waitForStatus(appGid, ['complete'])
  await waitForStatus(traversalGid, ['complete'])
  pass('real aria2 downloads', { appGid, traversalGid })

  const appStatus = await apiJson(`/api/downloads/status/${appGid}`)
  assert.equal(appStatus.status, 'complete')
  const downloaded = await readFile(path.join(downloadDir, 'testbot-app.bin'))
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), appExpectedSha)
  pass('downloaded fixture SHA-256', { bytes: downloaded.length, sha256: appExpectedSha })

  await runCliTestBot(appGid, controlGid, incompleteGid, traversalGid, appExpectedSha)
  await waitForStatus(controlGid, ['complete'])
  pass('post-resume completion', { controlGid })

  const controlPath = path.join(downloadDir, 'testbot-control.bin')
  const controlSize = 32 * 1024 * 1024
  await truncate(controlPath, 1)
  const beforeHeaders = await api(`/api/downloads/file/${controlGid}`)
  assert.equal(beforeHeaders.status, 409)
  await beforeHeaders.arrayBuffer().catch(() => undefined)
  await writeFile(controlPath, fixtureBuffer(controlSize))
  pass('truncated file rejected before streaming', { controlGid })

  // Open a completed large file, truncate it after the response headers are
  // sent, and require the streaming route to reject the changed byte count.
  const truncatedResponse = await api(`/api/downloads/file/${controlGid}`)
  assert.equal(truncatedResponse.status, 200)
  await truncate(controlPath, 1)
  let truncatedRejected = false
  try {
    const body = await truncatedResponse.arrayBuffer()
    truncatedRejected = body.byteLength !== 32 * 1024 * 1024
  } catch {
    truncatedRejected = true
  }
  assert.equal(truncatedRejected, true)
  pass('truncated completed-file stream rejected', { controlGid })

  await aria2Rpc('aria2.remove', [incompleteGid]).catch(() => undefined)
  report.status = 'passed'
}

try {
  await run()
} catch (error) {
  report.status = 'failed'
  report.error = safeError(error)
  fail('runner', error)
  process.exitCode = 1
} finally {
  await closeServer(appServer)
  await stopProcess(aria2Process)
  await closeServer(mediaServer)
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  try {
    await saveReport()
  } catch (error) {
    console.error(`Could not write ${reportPath}: ${safeError(error)}`)
    process.exitCode = 1
  }
  console.log(`TestBot report: ${reportPath}`)
  console.log(`TestBot status: ${report.status}`)
}
