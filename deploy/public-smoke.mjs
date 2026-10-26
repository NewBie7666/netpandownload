import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const STAGES = Object.freeze([
  'config',
  'unauthenticated_routes',
  'authenticated_home',
  'health',
  'active_downloads',
  'source_fixture',
  'create_download',
  'poll_download',
  'download_file',
  'cleanup'
])
const FIXTURE_PATH = new URL('./fixtures/node-v22.23.4-SHASUMS256.txt', import.meta.url)
const SOURCE_URL = 'https://nodejs.org/dist/v22.23.4/SHASUMS256.txt'
const FIXTURE_LENGTH = 3981
const FIXTURE_SHA256 = 'c90c3f1478fda8308b22cc1a1b0dc536169196444e67ee8b5c582fd351d02bce'
const POLL_ATTEMPTS = 90
let testGid

class SmokeFailure extends Error {
  constructor(stage, errorType, details = {}) {
    super(errorType)
    this.stage = stage
    this.errorType = errorType
    this.httpStatus = Number.isInteger(details.httpStatus) ? details.httpStatus : undefined
    this.taskErrorCode = typeof details.taskErrorCode === 'string' && /^[0-9]{1,4}$/.test(details.taskErrorCode)
      ? details.taskErrorCode
      : undefined
  }
}

function diagnostic(error) {
  const stage = STAGES.includes(error?.stage) ? error.stage : 'config'
  const result = { stage, errorType: /^[A-Za-z0-9_.-]{1,80}$/.test(error?.errorType || '') ? error.errorType : 'unexpected_error' }
  if (Number.isInteger(error?.httpStatus)) result.httpStatus = error.httpStatus
  if (error?.taskErrorCode) result.taskErrorCode = error.taskErrorCode
  return result
}

function requireResponse(response, stage) {
  if (!response || !Number.isInteger(response.status)) throw new SmokeFailure(stage, 'network_error')
  return response
}

async function fetchRoute(origin, path, headers, stage) {
  try {
    return requireResponse(await fetch(origin + path, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    }), stage)
  } catch (error) {
    if (error instanceof SmokeFailure) throw error
    throw new SmokeFailure(stage, 'network_error')
  }
}

async function jsonBody(response, stage) {
  try {
    return await response.json()
  } catch {
    throw new SmokeFailure(stage, 'invalid_json', { httpStatus: response.status })
  }
}

async function main() {
  let stage = 'config'
  const origin = process.env.NETPAN_TEST_BASE_URL
  const user = process.env.NETPAN_TEST_BASIC_USER
  const password = process.env.NETPAN_TEST_BASIC_PASSWORD
  const sha = process.env.DEPLOY_SHA
  if (!origin?.startsWith('https://') || !user || !password || !/^[0-9a-f]{40}$/.test(sha || '')) {
    throw new SmokeFailure(stage, 'invalid_configuration')
  }
  const authHeaders = { Authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64') }

  stage = 'unauthenticated_routes'
  for (const route of ['/', '/api/health', '/api/downloads/file/0123456789abcdef']) {
    const response = await fetchRoute(origin, route, {}, stage)
    if (response.status !== 401) throw new SmokeFailure(stage, 'unauthenticated_access', { httpStatus: response.status })
  }

  stage = 'authenticated_home'
  const page = await fetchRoute(origin, '/', authHeaders, stage)
  if (page.status !== 200) throw new SmokeFailure(stage, 'authenticated_access', { httpStatus: page.status })
  try {
    if (!/<html/i.test(await page.text())) throw new Error('missing html')
  } catch (error) {
    if (error instanceof SmokeFailure) throw error
    throw new SmokeFailure(stage, 'invalid_response', { httpStatus: page.status })
  }

  stage = 'health'
  const health = await fetchRoute(origin, '/api/health', authHeaders, stage)
  if (health.status !== 200) throw new SmokeFailure(stage, 'health_http_status', { httpStatus: health.status })
  const healthResult = (await jsonBody(health, stage))?.result
  if (!healthResult || healthResult.releaseSha !== sha || healthResult.privateWeb !== true || healthResult.mock !== false) {
    throw new SmokeFailure(stage, 'health_identity')
  }

  stage = 'active_downloads'
  const active = await fetchRoute(origin, '/api/downloads/active', authHeaders, stage)
  if (active.status !== 200 || (await jsonBody(active, stage))?.ok !== true) {
    throw new SmokeFailure(stage, 'active_downloads_failed', { httpStatus: active.status })
  }

  stage = 'source_fixture'
  let expected
  try {
    expected = await readFile(FIXTURE_PATH)
  } catch {
    throw new SmokeFailure(stage, 'fixture_unavailable')
  }
  if (expected.length !== FIXTURE_LENGTH || createHash('sha256').update(expected).digest('hex') !== FIXTURE_SHA256) {
    throw new SmokeFailure(stage, 'fixture_mismatch')
  }

  stage = 'create_download'
  let response
  try {
    response = requireResponse(await fetch(origin + '/api/downloads/direct', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ url: SOURCE_URL, fileName: `netpan-acceptance-${sha}.txt` }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    }), stage)
  } catch (error) {
    if (error instanceof SmokeFailure) throw error
    throw new SmokeFailure(stage, 'network_error')
  }
  if (response.status !== 200) throw new SmokeFailure(stage, 'create_download_failed', { httpStatus: response.status })
  const created = await jsonBody(response, stage)
  const gid = created?.result?.gid
  if (typeof gid !== 'string' || !/^[0-9a-f]{16}$/.test(gid)) throw new SmokeFailure(stage, 'invalid_task_id')
  testGid = gid

  stage = 'poll_download'
  let complete = false
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const status = await fetchRoute(origin, `/api/downloads/status/${testGid}`, authHeaders, stage)
    if (status.status !== 200) throw new SmokeFailure(stage, 'status_http_status', { httpStatus: status.status })
    const task = (await jsonBody(status, stage))?.result
    if (task?.status === 'error' || task?.status === 'removed') {
      throw new SmokeFailure(stage, 'task_error', { taskErrorCode: task.errorCode || task.code })
    }
    if (task?.status === 'complete') {
      complete = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (!complete) throw new SmokeFailure(stage, 'task_timeout')

  stage = 'download_file'
  const saved = await fetchRoute(origin, `/api/downloads/file/${testGid}`, authHeaders, stage)
  if (saved.status !== 200) throw new SmokeFailure(stage, 'file_http_status', { httpStatus: saved.status })
  if (!/attachment/i.test(saved.headers?.get?.('content-disposition') || '')) throw new SmokeFailure(stage, 'missing_attachment')
  let actual
  try {
    actual = Buffer.from(await saved.arrayBuffer())
  } catch {
    throw new SmokeFailure(stage, 'invalid_file_body', { httpStatus: saved.status })
  }
  if (actual.length !== expected.length) throw new SmokeFailure(stage, 'file_length_mismatch')
  if (createHash('sha256').update(actual).digest('hex') !== FIXTURE_SHA256) throw new SmokeFailure(stage, 'file_hash_mismatch')

  console.log('Public HTTPS, private authentication, exact release, real Node.js checksum download and SHA-256 verified')
}

let failure
try {
  await main()
} catch (error) {
  failure = diagnostic(error)
} finally {
  const origin = process.env.NETPAN_TEST_BASE_URL
  const user = process.env.NETPAN_TEST_BASIC_USER
  const password = process.env.NETPAN_TEST_BASIC_PASSWORD
  if (origin && user && password && testGid) {
    try {
      const cleanupResponse = await fetch(origin + `/api/downloads/remove/${testGid}`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64'),
          'Content-Type': 'application/json',
          Origin: origin
        },
        body: JSON.stringify({ deleteFile: true }),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000)
      })
      if (!failure && cleanupResponse.status !== 200) failure = { stage: 'cleanup', errorType: 'cleanup_failed', httpStatus: cleanupResponse.status }
    } catch {
      if (!failure) failure = { stage: 'cleanup', errorType: 'cleanup_failed' }
    }
  }
}
if (failure) {
  console.error('Public HTTPS smoke failed ' + JSON.stringify(failure))
  process.exitCode = 1
}
