import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const origin = process.env.NETPAN_TEST_BASE_URL
const user = process.env.NETPAN_TEST_BASIC_USER
const password = process.env.NETPAN_TEST_BASIC_PASSWORD
const sha = process.env.DEPLOY_SHA
assert(origin?.startsWith('https://') && user && password)
const headers = { Authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64') }
let testGid
const get = (path, authenticated) => fetch(origin + path, {
  headers: authenticated ? headers : {}, redirect: 'manual', signal: AbortSignal.timeout(15000)
})
try {
  for (const route of ['/', '/api/health', '/api/downloads/file/0123456789abcdef']) {
    assert.equal((await get(route, false)).status, 401, 'unauthenticated route must be denied')
  }
  const page = await get('/', true)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html/i)
  const health = await get('/api/health', true)
  assert.equal(health.status, 200)
  const result = (await health.json()).result
  assert.equal(result.releaseSha, sha)
  assert.equal(result.privateWeb, true)
  assert.equal(result.mock, false)
  const active = await get('/api/downloads/active', true)
  assert.equal(active.status, 200)
  assert.equal((await active.json()).ok, true)
  const expected = await readFile('README.md')
  const response = await fetch(origin + '/api/downloads/direct', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ url: `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/${sha}/README.md`, fileName: `netpan-acceptance-${sha}.txt` }),
    redirect: 'manual', signal: AbortSignal.timeout(15000)
  })
  assert.equal(response.status, 200)
  testGid = (await response.json()).result.gid
  assert.match(testGid, /^[0-9a-f]{16}$/)
  let complete = false
  for (let attempt = 0; attempt < 45; attempt++) {
    const status = await get(`/api/downloads/status/${testGid}`, true)
    assert.equal(status.status, 200)
    const task = (await status.json()).result
    assert(!['error', 'removed'].includes(task.status), 'acceptance file transfer failed')
    if (task.status === 'complete') { complete = true; break }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert(complete, 'acceptance transfer timed out')
  const saved = await get(`/api/downloads/file/${testGid}`, true)
  assert.equal(saved.status, 200)
  assert.match(saved.headers.get('content-disposition') || '', /attachment/)
  const actual = Buffer.from(await saved.arrayBuffer())
  assert.equal(actual.length, expected.length)
  assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(expected).digest('hex'))
  console.log('Public HTTPS, private authentication, exact release, real download and browser SHA-256 verified')
} catch {
  console.error('Public HTTPS smoke failed (credentials and response bodies withheld)')
  process.exitCode = 1
} finally {
  if (testGid) {
    await fetch(origin + `/api/downloads/remove/${testGid}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ deleteFile: true }), redirect: 'manual', signal: AbortSignal.timeout(15000)
    }).catch(() => console.error('Acceptance task cleanup needs review'))
  }
}
