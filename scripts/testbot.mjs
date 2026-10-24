#!/usr/bin/env node

/**
 * HTTP acceptance TestBot for the private web deployment.
 *
 * The bot talks to a running service over HTTP(S), so it exercises the same
 * reverse-proxy path used by a phone or desktop browser. It never prints the
 * bearer token or response bodies. A completed GID can be supplied with
 * --gid/NETPAN_TEST_GID to verify streaming delivery and a SHA-256 digest.
 * An active GID can be supplied separately to exercise pause/resume.
 *
 * Examples:
 *   node scripts/testbot.mjs --base-url https://downloads.example.test \
 *     --token "$NETPAN_WEB_TOKEN" --gid 0123456789abcdef \
 *     --expected-sha256 0123... --origin https://downloads.example.test
 *
 * Optional direct submission is intentionally opt-in. The supplied URL must
 * be a public HTTP(S) fixture accepted by the application's SSRF checks:
 *   node scripts/testbot.mjs --base-url ... --token ... \
 *     --direct-url https://fixture.example.test/test.bin --file-name test.bin
 */

import { createHash } from 'node:crypto'

function usage(message) {
  if (message) console.error(`TestBot error: ${message}`)
  console.error(`Usage: node scripts/testbot.mjs --base-url URL --token TOKEN [options]

Required:
  --base-url URL                 Private web origin, for example https://host
  --token TOKEN                  NETPAN_WEB_TOKEN (never printed)

Options:
  --origin URL                   Origin header sent with API requests
  --basic-user USER              Optional Nginx Basic Auth user
  --basic-password PASSWORD      Optional Nginx Basic Auth password (never printed)
  --gid GID                      Completed aria2 GID to stream and hash
  --expected-sha256 HEX          Expected SHA-256 for --gid's response body
  --incomplete-gid GID           GID expected to be rejected as incomplete
  --traversal-gid GID            GID whose aria2 path is expected outside root
  --active-gid GID               GID for pause/resume checks
  --direct-url URL               Public fixture URL to submit to /api/downloads/direct
  --file-name NAME               Optional output name for --direct-url
  --poll-ms N                    Poll interval (default 1000)
  --timeout-ms N                 Poll timeout (default 60000)
  --health-only                  Only run the authentication/health check
  --help                         Show this help`)
  process.exit(message ? 2 : 0)
}

function parseArgs(argv) {
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--help' || item === '--health-only') flags.add(item)
    else if (!item.startsWith('--')) usage(`unexpected argument: ${item}`)
    else if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) usage(`missing value for ${item}`)
    else values.set(item, argv[++index])
  }
  return { values, flags }
}

const { values, flags } = parseArgs(process.argv.slice(2))
if (flags.has('--help')) usage()

const baseUrl = String(values.get('--base-url') || process.env.NETPAN_TEST_BASE_URL || '').trim().replace(/\/+$/, '')
const token = String(values.get('--token') || process.env.NETPAN_WEB_TOKEN || '').trim()
const origin = String(values.get('--origin') || process.env.NETPAN_TEST_ORIGIN || '').trim()
const basicUser = String(values.get('--basic-user') || process.env.NETPAN_TEST_BASIC_USER || '')
const basicPassword = String(values.get('--basic-password') || process.env.NETPAN_TEST_BASIC_PASSWORD || '')
const gid = String(values.get('--gid') || process.env.NETPAN_TEST_GID || '').trim()
const expectedSha = String(values.get('--expected-sha256') || process.env.NETPAN_TEST_SHA256 || '').trim().toLowerCase()
const incompleteGid = String(values.get('--incomplete-gid') || process.env.NETPAN_TEST_INCOMPLETE_GID || '').trim()
const traversalGid = String(values.get('--traversal-gid') || process.env.NETPAN_TEST_TRAVERSAL_GID || '').trim()
const activeGid = String(values.get('--active-gid') || process.env.NETPAN_TEST_ACTIVE_GID || '').trim()
const directUrl = String(values.get('--direct-url') || '').trim()
const fileName = String(values.get('--file-name') || '').trim()
const pollMs = Math.max(100, Number(values.get('--poll-ms') || 1000))
const timeoutMs = Math.max(pollMs, Number(values.get('--timeout-ms') || 60000))

if (!baseUrl) usage('--base-url (or NETPAN_TEST_BASE_URL) is required')
if (!token || token.length < 32) usage('--token (or NETPAN_WEB_TOKEN) must be at least 32 characters')
if ((basicUser && !basicPassword) || (!basicUser && basicPassword)) usage('--basic-user and --basic-password must be supplied together')
try {
  const parsed = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol')
} catch {
  usage('--base-url must be an absolute HTTP(S) URL')
}
if (expectedSha && !/^[0-9a-f]{64}$/.test(expectedSha)) usage('--expected-sha256 must be 64 hexadecimal characters')

const headers = () => {
  const result = {
    Accept: 'application/json',
    // This header is injected by the authenticated Nginx location in production.
    'X-Netpan-Token': token,
    Authorization: basicUser || basicPassword
      ? `Basic ${Buffer.from(`${basicUser}:${basicPassword}`, 'utf8').toString('base64')}`
      : `Bearer ${token}`
  }
  if (origin) result.Origin = origin
  return result
}

async function request(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
    redirect: 'manual'
  })
  return response
}

async function json(response) {
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status} returned a non-JSON response`)
  }
  if (!payload || payload.ok !== true) {
    throw new Error(`HTTP ${response.status} returned an API error`)
  }
  return payload.result
}

async function expectStatus(pathname, expected, label) {
  const response = await request(pathname)
  if (response.status !== expected) throw new Error(`${label} expected HTTP ${expected}, got ${response.status}`)
  return response
}

async function checkHealth() {
  const unauthenticated = await fetch(`${baseUrl}/api/health`, {
    headers: origin ? { Origin: origin } : {},
    redirect: 'manual'
  })
  if (unauthenticated.status !== 401) {
    throw new Error(`unauthenticated health expected HTTP 401, got ${unauthenticated.status}`)
  }
  const health = await json(await request('/api/health'))
  if (!health || health.privateWeb !== true) throw new Error('health response did not report privateWeb=true')
  console.log('PASS health: unauthenticated request rejected; authenticated private-web health is OK')
}

async function submitDirect() {
  if (!directUrl) return undefined
  let parsed
  try { parsed = new URL(directUrl) } catch { throw new Error('--direct-url must be an absolute URL') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--direct-url must use HTTP(S)')
  const body = { url: parsed.toString() }
  if (fileName) body.fileName = fileName
  const result = await json(await request('/api/downloads/direct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }))
  if (!result || !/^[0-9a-f]{16}$/i.test(String(result.gid || ''))) throw new Error('direct submission returned no valid aria2 GID')
  console.log('PASS direct submission: server accepted a public fixture and returned a task GID')
  return String(result.gid)
}

async function taskStatus(taskGid) {
  const result = await json(await request(`/api/downloads/status/${encodeURIComponent(taskGid)}`))
  if (!result || result.gid !== taskGid) throw new Error('status response returned an unexpected GID')
  return result
}

async function pollComplete(taskGid) {
  const started = Date.now()
  let sawActive = false
  while (Date.now() - started <= timeoutMs) {
    const status = await taskStatus(taskGid)
    if (['active', 'waiting', 'paused'].includes(status.status)) sawActive = true
    if (status.status === 'complete') {
      console.log(`PASS task state: ${taskGid} reached complete${sawActive ? ' after an active state' : ''}`)
      return status
    }
    if (['error', 'removed'].includes(status.status)) throw new Error(`task ${taskGid} ended in ${status.status}`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`task ${taskGid} did not complete within timeout`)
}

async function streamCompleted(taskGid) {
  const response = await request(`/api/downloads/file/${encodeURIComponent(taskGid)}`)
  if (response.status !== 200 || !response.body) throw new Error(`completed file expected HTTP 200, got ${response.status}`)
  const digest = createHash('sha256')
  let bytes = 0
  const reader = response.body.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    const value = Buffer.from(chunk.value)
    bytes += value.length
    digest.update(value)
  }
  const actualSha = digest.digest('hex')
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (!Number.isSafeInteger(contentLength) || contentLength !== bytes) {
    throw new Error(`completed file length mismatch: header=${contentLength}, body=${bytes}`)
  }
  if (expectedSha && expectedSha !== actualSha) throw new Error('completed file SHA-256 mismatch')
  if (!/attachment/i.test(response.headers.get('content-disposition') || '')) {
    throw new Error('completed file response lacks attachment Content-Disposition')
  }
  console.log(`PASS browser stream: ${bytes} bytes received with SHA-256 ${actualSha}`)
}

async function pauseResume(taskGid) {
  const before = await taskStatus(taskGid)
  if (!['active', 'waiting'].includes(before.status)) throw new Error(`active GID is ${before.status}; cannot test pause/resume`)
  const pause = await request(`/api/downloads/pause/${encodeURIComponent(taskGid)}`, { method: 'POST' })
  if (pause.status !== 200) throw new Error(`pause expected HTTP 200, got ${pause.status}`)
  const paused = await taskStatus(taskGid)
  if (!['paused', 'complete'].includes(paused.status)) throw new Error(`pause did not produce paused/complete state (got ${paused.status})`)
  if (paused.status === 'paused') {
    const resume = await request(`/api/downloads/resume/${encodeURIComponent(taskGid)}`, { method: 'POST' })
    if (resume.status !== 200) throw new Error(`resume expected HTTP 200, got ${resume.status}`)
  }
  console.log(`PASS task controls: pause/resume accepted for ${taskGid}`)
}

async function main() {
  await checkHealth()
  const submittedGid = await submitDirect()
  const completedGid = submittedGid || gid
  if (!completedGid && !flags.has('--health-only')) {
    throw new Error('a completed --gid or --direct-url is required (use --health-only only for a deliberate health probe)')
  }
  if (completedGid) {
    await pollComplete(completedGid)
    await streamCompleted(completedGid)
  }
  if (activeGid) await pauseResume(activeGid)
  if (incompleteGid) await expectStatus(`/api/downloads/file/${encodeURIComponent(incompleteGid)}`, 409, 'incomplete file')
  if (traversalGid) await expectStatus(`/api/downloads/file/${encodeURIComponent(traversalGid)}`, 403, 'out-of-directory file')
  await expectStatus('/api/downloads/file/not-a-gid', 400, 'invalid GID')
  console.log('TestBot completed successfully')
}

main().catch((error) => {
  console.error(`TestBot failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exitCode = 1
})
