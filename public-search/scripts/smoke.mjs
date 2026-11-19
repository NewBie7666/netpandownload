import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../release/public-search-staging/', import.meta.url))
const reserve = http.createServer().listen(0, '127.0.0.1')
await new Promise(resolve => reserve.once('listening', resolve))
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const token = 'artifact-smoke-token-' + 'a'.repeat(32)
const child = spawn(process.execPath, ['dist-public/server/public-search/server/index.js'], {
  cwd: root, env: { ...process.env, PUBLIC_SEARCH_ORIGIN: 'https://search.example.test', PUBLIC_SEARCH_PROXY_TOKEN: token,
    PUBLIC_SEARCH_PORT: String(port), NETPAN_PRIVATE_WEB: 'true', QUARK_COOKIE: 'PRIVATE_SENTINEL_NOT_FOR_PUBLIC',
    QUARK_MOCK: 'true', PORT: '1' }, stdio: ['ignore', 'pipe', 'pipe']
})
let logs = ''
child.stdout.on('data', chunk => { logs += chunk })
child.stderr.on('data', chunk => { logs += chunk })
function request(route, method = 'GET', authenticated = true) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route,
      headers: { host: 'search.example.test', 'x-real-ip': '127.0.0.1', ...(authenticated ? { 'x-public-search-token': token } : {}) }
    }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject); req.end()
  })
}
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { if ((await request('/api/health')).status === 200) { ready = true; break } } catch {}
    if (child.exitCode !== null) throw new Error('Artifact exited: ' + logs)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready, 'artifact must start with only its installed runtime dependencies')
  assert.equal((await request('/api/health', 'GET', false)).status, 403)
  const health = await request('/api/health')
  assert.deepEqual(JSON.parse(health.body), { ok: true, result: { service: 'public-search' } })
  const page = await request('/')
  assert.equal(page.status, 200)
  assert.match(page.body, /<title>通用搜索<\/title>/)
  assert.match(page.headers['content-security-policy'], /default-src 'none'/)
  const script = page.body.match(/src="([^"]+\.js)"/)[1]
  const asset = await request(script)
  assert.equal(asset.status, 200)
  assert.doesNotMatch(asset.body, /addDownloadTask|\/api\/downloads|\/api\/product|\/api\/auth|download-engine/)
  assert.equal((await request('/api/search?q=x')).status, 400)
  const forbidden = ['/api/downloads/tasks', '/api/download-engine/tasks', '/api/providers/download', '/api/quark/download', '/api/product/history', '/api/auth/douyin/status', '/api/settings']
  for (const route of forbidden) for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    assert.equal((await request(route, method)).status, 404, method + ' ' + route)
  }
  for (const route of ['/.env', '/package.json', '/BUILD_MANIFEST.json', '/data/settings.json', '/dist-server/server/index.js']) {
    assert.equal((await request(route)).status, 404, route)
  }
  assert.doesNotMatch(health.body + page.body + asset.body + logs, /PRIVATE_SENTINEL_NOT_FOR_PUBLIC/)
  const manifest = JSON.parse(await readFile(path.join(root, 'BUILD_MANIFEST.json'), 'utf8'))
  for (const file of manifest.files) {
    assert.equal(createHash('sha256').update(await readFile(path.join(root, file.path))).digest('hex'), file.sha256, file.path)
    assert.doesNotMatch(file.path, /(?:downloader|download-engine|auth\/|dist-server|data\/|\.env$|\.map$)/)
  }
  console.info('Installed artifact smoke passed: static page, assets, health, blocked download APIs, secret isolation and manifest hashes.')
} finally {
  child.kill()
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) })
}
