import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const ROOT = new URL('.', import.meta.url)
const SMOKE = new URL('./public-smoke.mjs', ROOT)
const FIXTURE = new URL('./fixtures/node-v22.23.4-SHASUMS256.txt', ROOT)
const SHA = 'a'.repeat(40)
const SECRET = 'sentinel-password-must-not-appear'

const LOADER = String.raw`
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fixture = readFileSync(process.env.SMOKE_FIXTURE)
const scenario = process.env.SMOKE_SCENARIO
const cleanupLog = process.env.SMOKE_CLEANUP_LOG
const gid = '0123456789abcdef'
let polls = 0
const logCleanup = () => { if (cleanupLog) appendFileSync(cleanupLog, 'cleanup\\n') }
class ResponseMock {
  constructor(status, body, headers = {}) {
    this.status = status
    this.body = body
    this.headers = { get: name => headers[String(name).toLowerCase()] || null }
  }
  async json() { return this.body }
  async text() { return Buffer.isBuffer(this.body) ? this.body.toString() : String(this.body) }
  async arrayBuffer() {
    const bytes = Buffer.isBuffer(this.body) ? this.body : Buffer.from(this.body)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
}
const auth = options => Boolean(options?.headers?.Authorization)
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input))
  const path = url.pathname
  if (path === '/api/downloads/remove/' + gid) {
    logCleanup()
    return new ResponseMock(200, { ok: true })
  }
  if (!auth(options)) {
    if (scenario === 'unauthenticated-200' && path === '/') return new ResponseMock(200, '<html>public</html>')
    return new ResponseMock(401, {})
  }
  if (path.startsWith('/api/downloads/status/')) {
    polls += 1
    if (scenario === 'task-error') return new ResponseMock(200, { result: { status: 'error', errorCode: '3' } })
    if (scenario === 'unsafe-error-code') return new ResponseMock(200, { result: { status: 'error', errorCode: process.env.NETPAN_TEST_BASIC_PASSWORD } })
    if (scenario === 'incomplete') return new ResponseMock(200, { result: { status: 'pending' } })
    return new ResponseMock(200, { result: { status: 'complete' } })
  }
  if (path === '/api/downloads/direct' && options.method === 'POST') {
    const request = JSON.parse(options.body)
    if (request.url !== 'https://nodejs.org/dist/v22.23.4/SHASUMS256.txt') return new ResponseMock(400, {})
    return new ResponseMock(200, { result: { gid } })
  }
  if (path === '/api/downloads/file/' + gid) {
    if (scenario === 'truncated-file') return new ResponseMock(200, fixture.subarray(0, fixture.length - 1), { 'content-disposition': 'attachment; filename=test.txt' })
    if (scenario === 'hashbad-file') {
      const bad = Buffer.from(fixture)
      bad[bad.length - 1] ^= 0xff
      return new ResponseMock(200, bad, { 'content-disposition': 'attachment; filename=test.txt' })
    }
    return new ResponseMock(200, fixture, { 'content-disposition': 'attachment; filename=test.txt' })
  }
  if (scenario === 'bad-basic-auth' && path === '/') return new ResponseMock(401, {})
  if (path === '/') return new ResponseMock(200, '<!doctype html><html>private</html>')
  if (path === '/api/health') {
    const releaseSha = scenario === 'wrong-release' ? 'b'.repeat(40) : process.env.DEPLOY_SHA
    return new ResponseMock(200, { result: { releaseSha, privateWeb: true, mock: false } })
  }
  if (path === '/api/downloads/active') return new ResponseMock(200, { ok: true })
  return new ResponseMock(404, {})
}
if (process.env.SMOKE_TEST_FAST === '1') {
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, Math.min(delay, 1), ...args)
}
`

async function runCase(scenario) {
  const directory = await mkdtemp(join(tmpdir(), 'netpan-smoke-'))
  const loader = join(directory, 'loader.mjs')
  const cleanup = join(directory, 'cleanup.log')
  await writeFile(loader, LOADER)
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(loader).href, fileURLToPath(SMOKE)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NETPAN_TEST_BASE_URL: 'https://download.example.test',
      NETPAN_TEST_BASIC_USER: 'admin',
      NETPAN_TEST_BASIC_PASSWORD: SECRET,
      DEPLOY_SHA: SHA,
      SMOKE_SCENARIO: scenario,
      SMOKE_FIXTURE: fileURLToPath(FIXTURE),
      SMOKE_CLEANUP_LOG: cleanup,
      SMOKE_TEST_FAST: '1'
    },
    timeout: 15000
  })
  const output = result.stdout + result.stderr + (await readFile(cleanup).catch(() => Buffer.alloc(0))).toString()
  return { result, output }
}

function assertDiagnostic(result, stage, errorType, httpStatus, output = result.stdout + result.stderr) {
  assert.notEqual(result.status, 0, result.stdout)
  const line = result.stderr.split('\n').find(value => value.startsWith('Public HTTPS smoke failed '))
  assert.ok(line, result.stderr)
  const diagnostic = JSON.parse(line.slice('Public HTTPS smoke failed '.length))
  assert.equal(diagnostic.stage, stage)
  assert.equal(diagnostic.errorType, errorType)
  if (httpStatus !== undefined) assert.equal(diagnostic.httpStatus, httpStatus)
  assert.doesNotMatch(output, new RegExp(SECRET))
}

test('healthy smoke verifies fixture download and cleanup', async () => {
  const { result, output } = await runCase('healthy')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /SHA-256 verified/)
  assert.match(output, /cleanup/)
  assert.doesNotMatch(output, new RegExp(SECRET))
})

test('unauthenticated route returning 200 fails at access gate', async () => {
  const { result, output } = await runCase('unauthenticated-200')
  assertDiagnostic(result, 'unauthenticated_routes', 'unauthenticated_access', 200, output)
})

test('bad basic authentication fails at authenticated home', async () => {
  const { result, output } = await runCase('bad-basic-auth')
  assertDiagnostic(result, 'authenticated_home', 'authenticated_access', 401, output)
})

test('wrong release identity fails health check', async () => {
  const { result, output } = await runCase('wrong-release')
  assertDiagnostic(result, 'health', 'health_identity', undefined, output)
})

test('download task error fails early and cleans up', async () => {
  const { result, output } = await runCase('task-error')
  assertDiagnostic(result, 'poll_download', 'task_error', undefined, output)
  assert.match(output, /"taskErrorCode":"3"/)
})

test('untrusted task error text is withheld from diagnostics', async () => {
  const { result, output } = await runCase('unsafe-error-code')
  assertDiagnostic(result, 'poll_download', 'task_error', undefined, output)
  assert.doesNotMatch(output, /taskErrorCode/)
})

test('incomplete task times out at bounded poll stage', async () => {
  const { result, output } = await runCase('incomplete')
  assertDiagnostic(result, 'poll_download', 'task_timeout', undefined, output)
})

test('truncated file fails length verification', async () => {
  const { result, output } = await runCase('truncated-file')
  assertDiagnostic(result, 'download_file', 'file_length_mismatch', undefined, output)
  assert.match(output, /cleanup/)
})

test('hash-bad file fails SHA-256 verification', async () => {
  const { result, output } = await runCase('hashbad-file')
  assertDiagnostic(result, 'download_file', 'file_hash_mismatch', undefined, output)
})
