import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const appRoot = process.cwd()
const playwrightPath = join(appRoot, '..', '网盘下载', 'node_modules', 'playwright', 'index.mjs')
const { chromium } = await import(pathToFileURL(playwrightPath))
const scratch = await mkdtemp(join(tmpdir(), 'netpan-tvbox-smoke-'))
const profile = join(scratch, 'profile')
const files = join(scratch, 'downloaded')
await mkdir(files)
const port = 21396
const debug = 'http://127.0.0.1:' + port
const portable = process.env.NETPAN_QA_EXECUTABLE || join(appRoot, 'release', 'NetPanDownload-0.1.0-windows-x64.exe')
const { NETPAN_FFMPEG_PATH: _ignored, ...env } = process.env
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'path') env[key] = join(process.env.SystemRoot, 'System32') + ';' + process.env.SystemRoot
}
const application = spawn(portable, ['--remote-debugging-port=' + port, '--user-data-dir=' + profile], {
  cwd: scratch,
  env: { ...env, NETPAN_VIDEO_SOURCE_FILE: join(scratch, 'sources.json') },
  windowsHide: true,
  stdio: 'ignore'
})
let spawnError
application.on('error', error => { spawnError = error })
let browser
let cdp
try {
  let debugging
  for (let attempt = 0; attempt < 90; attempt++) {
    if (spawnError) throw spawnError
    if (application.exitCode !== null) throw new Error('portable exited before opening its window: ' + application.exitCode)
    try {
      const response = await fetch(debug + '/json/version', { signal: AbortSignal.timeout(700) })
      if (response.ok) { debugging = await response.json(); break }
    } catch {}
    await wait(600)
  }
  assert.ok(debugging, 'portable did not publish a devtools endpoint')
  browser = await chromium.connectOverCDP(debug)
  cdp = await browser.newBrowserCDPSession()
  let pages = []; for (let attempt = 0; attempt < 50; attempt++) { pages = browser.contexts().flatMap(context => context.pages()); if (pages.length) break; await wait(400) }
  assert.equal(pages.length, 1, 'expected the packaged main window')
  const page = pages[0]
  page.setDefaultTimeout(20000)
  await page.getByRole('button', { name: '影视源下载' }).waitFor()
  const origin = new URL(page.url()).origin
  console.log('Portable opened:', origin, debugging.Browser)
  async function api(path, body) {
    const response = await page.request.fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { data: body })
    })
    const result = await response.json()
    assert.ok(response.ok() && result.ok, path + ' ' + JSON.stringify(result))
    return result.result
  }
  if (process.env.NETPAN_QA_FINAL === '1') {
    for (const route of ['/api/video-sources/sources', '/api/downloads/hls']) {
      const denied = await page.request.get(origin + route, { headers: { Origin: 'https://example.org' } })
      assert.equal(denied.status(), 403, 'cross-origin request should not reach ' + route)
    }
  }
  const settings = await api('/api/downloads/settings')
  assert.equal(settings.downloadDir, settings.defaultDownloadDir, 'QA profile did not isolate existing settings')
  assert.ok((await readdir(profile)).length, 'Chromium QA user-data dir is missing')
  await api('/api/downloads/settings', { downloadDir: files })
  assert.ok((await api('/api/downloads/active')).enabled, 'bundled aria2 is unavailable')

  const vod = {
    vod_id: '7',
    vod_name: 'NetPan TVBox Smoke',
    vod_play_from: 'direct$$$m3u8',
    vod_play_url: 'MP4 Sample$https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
      + '$$$HLS Sample$https://test-streams.mux.dev/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8'
  }
  const catalog = Buffer.from(JSON.stringify({ page: 1, pagecount: 1, list: [vod] })).toString('base64')
  assert.doesNotMatch(catalog, /[/+]/, 'fixture must be a single path segment')
  const config = {
    sites: [
      { key: 'smoke', name: 'TVBox QA Catalog', type: 1, api: 'https://httpbingo.org/base64/' + catalog },
      { key: 'unsupported', name: 'Unsupported Type Fixture', type: 4, api: 'https://example.com/unsupported' }
    ]
  }
  const configPayload = Buffer.from(JSON.stringify(config)).toString('base64')
  assert.doesNotMatch(configPayload, /[/+]/, 'config fixture must be a single path segment')
  await page.getByRole('button', { name: '影视源下载' }).click()
  for (const name of ['磁力搜索', '链接解析', '下载管理']) {
    assert.equal(await page.getByRole('button', { name }).count(), 1)
  }
  await page.getByLabel('影视源配置 URL / JSON').fill('https://httpbingo.org/base64/' + configPayload)
  await page.getByRole('button', { name: '一键导入影视源' }).click()
  await page.getByText('新增站点 1 个', { exact: false }).waitFor({ timeout: 50000 })
  await page.getByText('查看尚不兼容的站点（1）').click()
  await page.getByText(/Unsupported Type Fixture/).waitFor()
  assert.match(await readFile(join(scratch, 'sources.json'), 'utf8'), /TVBox QA Catalog/)
  await page.getByLabel('影视名称').fill('NetPan TVBox Smoke')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: '查看剧集' }).click({ timeout: 50000 })
  await page.getByRole('button', { name: 'MP4 Sample · 下载 MP4' }).click({ timeout: 50000 })
  await page.getByText('已加入下载任务：NetPan TVBox Smoke-MP4 Sample.mp4').waitFor({ timeout: 50000 })
  await page.getByRole('button', { name: 'HLS Sample · 下载 HLS' }).click()
  await page.getByText('已加入下载任务：NetPan TVBox Smoke-HLS Sample.mp4').waitFor({ timeout: 50000 })
  await page.getByRole('button', { name: '查看下载任务' }).click()
  const hlsRow = page.getByRole('row').filter({ hasText: 'NetPan TVBox Smoke-HLS Sample' })
  await hlsRow.waitFor()
  if (process.env.NETPAN_QA_FINAL === '1') {
    await hlsRow.getByRole('button', { name: '暂停', exact: true }).click()
    await hlsRow.getByRole('button', { name: '继续', exact: true }).click()
    console.log('HLS paused and resumed through the packaged UI')
  }
  console.log('TVBox URL imported; incompatible site shown; catalog searched; MP4 and HLS queued in 下载管理')

  const watched = new Map()
  let finished
  for (let attempt = 0; attempt < 110; attempt++) {
    const tasks = (await api('/api/downloads/active')).tasks.filter(task => task.fileName.startsWith('NetPan TVBox Smoke-'))
    for (const task of tasks) {
      if (watched.get(task.gid) !== task.status) {
        watched.set(task.gid, task.status)
        console.log(task.fileName, task.status, task.errorMessage || '')
      }
      assert.notEqual(task.status, 'error', task.fileName + ': ' + task.errorMessage)
    }
    if (tasks.length === 2 && tasks.every(task => task.status === 'complete')) { finished = tasks; break }
    await wait(1000)
  }
  assert.ok(finished, 'downloads did not complete within the smoke deadline')
  for (const task of finished) {
    const file = join(files, task.fileName)
    assert.ok((await stat(file)).size > 1024)
    const probe = execFileSync(join(appRoot, 'release', 'win-unpacked', 'resources', 'ffmpeg', 'win', 'ffprobe.exe'),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], {
        encoding: 'utf8', windowsHide: true
      }).trim()
    assert.ok(probe, 'missing playable video track in ' + task.fileName)
    execFileSync(join(appRoot, 'release', 'win-unpacked', 'resources', 'ffmpeg', 'win', 'ffmpeg.exe'),
      ['-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-t', '1', '-f', 'null', '-'], { windowsHide: true })
    console.log('Completed and decoded:', task.fileName, probe, (await stat(file)).size, 'bytes')
  }
  if (process.env.NETPAN_QA_FINAL === '1') {
    await page.getByRole('button', { name: '影视源下载', exact: true }).click()
    await page.getByText('直接下载 m3u8', { exact: true }).click()
    await page.getByLabel('m3u8 地址').fill('https://test-streams.mux.dev/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8')
    await page.getByLabel('MP4 文件名（可选）').fill('NetPan Manual Smoke.mp4')
    await page.getByRole('button', { name: '添加 HLS 下载任务', exact: true }).click()
    await page.getByText('已加入下载任务：NetPan Manual Smoke.mp4').waitFor()
    const manual = (await api('/api/downloads/active')).tasks.find(task => task.fileName.startsWith('NetPan Manual Smoke'))
    assert.ok(manual?.gid.startsWith('hls-'), 'manual m3u8 did not create an HLS job')
    await api('/api/downloads/remove/' + manual.gid, {})
    console.log('Manual m3u8 form created a removable download task')
  }
} catch (error) {
  if (browser) {
    const page = browser.contexts().flatMap(context => context.pages())[0]
    if (page) {
      const alerts = await page.getByRole('alert').allTextContents().catch(() => [])
      if (alerts.length) console.error('Application alerts:', alerts)
    }
  }
  console.error(error)
  process.exitCode = 1
} finally {
  if (cdp) {
    try { await Promise.race([cdp.send('Browser.close'), wait(2500)]) } catch {}
  }
  await wait(1800)
  if (application.exitCode === null && application.pid) {
    try { execFileSync('taskkill.exe', ['/PID', String(application.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
  if (browser) await browser.close().catch(() => {})
  console.log('Smoke data:', scratch)
}
