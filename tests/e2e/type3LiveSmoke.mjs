import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdtemp, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { transform } from 'esbuild'

// Explicit live acceptance rule, not evidence of compatibility with all community sources.
const root = process.cwd()
const playwright = process.env.NETPAN_PLAYWRIGHT_MODULE || path.join(root, '..', '网盘下载/node_modules/playwright/index.mjs')
const { chromium } = await import(pathToFileURL(playwright))
const scratch = await mkdtemp(path.join(tmpdir(), 'netpan-type3-live-'))
const sourceFile = path.join(scratch, 'sources.json')
const files = path.join(scratch, 'downloaded')
await mkdir(files)
const executable = process.env.NETPAN_QA_EXECUTABLE || path.join(root, 'release/NetPanDownload-0.1.0-windows-x64.exe')
const dev = process.env.NETPAN_QA_DEV === '1'
const port = 21407
const childEnv = { ...process.env, NETPAN_VIDEO_SOURCE_FILE: sourceFile }
delete childEnv.JAVA_HOME
delete childEnv.NETPAN_TYPE3_JAVA_ROOT
delete childEnv.NETPAN_FFMPEG_PATH
for (const key of Object.keys(childEnv)) {
  if (key.toLowerCase() === 'path') childEnv[key] = path.join(process.env.SystemRoot, 'System32') + ';' + process.env.SystemRoot
}
const child = spawn(executable, [...(dev ? [path.join(root, 'dist-electron/electron/main.js')] : []),
  '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(scratch, 'profile')], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: childEnv
})
let browser, cdp
const report = { date: new Date().toISOString(), executable, scratch, results: [] }
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('app exited before startup: ' + child.exitCode)
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break } catch {}
    await delay(500)
  }
  assert.ok(browser, 'app did not start')
  cdp = await browser.newBrowserCDPSession()
  let page
  for (let i = 0; i < 40; i++) {
    page = browser.contexts().flatMap(c => c.pages())[0]
    if (page) break
    await delay(300)
  }
  assert.ok(page)
  await page.getByRole('button', { name: '影视源下载', exact: true }).waitFor()
  const origin = new URL(page.url()).origin
  async function api(route, body) {
    const response = await page.request.fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { data: body }), timeout: 90000
    })
    const data = await response.json()
    assert.ok(response.ok() && data.ok, route + ': ' + JSON.stringify(data))
    return data.result
  }
  await api('/api/downloads/settings', { downloadDir: files })
  assert.equal((await api('/api/downloads/active')).enabled, true)
  const code = (await transform(await readFile(path.join(root, 'tests/fixtures/type3/nasa.js'), 'utf8'), { minify: true, format: 'esm' })).code
  const ruleUrl = 'https://httpbingo.org/base64/' + encodeURIComponent(Buffer.from(code).toString('base64'))
  assert.ok(ruleUrl.length < 2048)
  await page.getByRole('button', { name: '影视源下载', exact: true }).click()
  await page.getByLabel('影视源配置 URL / JSON').fill(JSON.stringify({ sites: [
    { key: 'nasa-live-js', name: 'NASA live acceptance JavaScript', type: 3, api: ruleUrl }
  ] }))
  await page.getByRole('button', { name: '一键导入影视源' }).click()
  await page.getByText('新增站点 1 个', { exact: false }).waitFor({ timeout: 30000 })
  const source = (await api('/api/video-sources/sources'))[0]
  const cases = [{ id: source.id, runtime: 'JavaScript', ui: true }]
  // Optional locally compiled live NASA fixtures exercise the exact production JVM bridge.
  // They use an explicit internal QA override, never a browser-supplied file path.
  for (const [variable, runtime] of [['NETPAN_QA_JVM_JAR', 'JVM JAR'], ['NETPAN_QA_DEX_JAR', 'DEX converted to JVM']]) {
    if (!process.env[variable]) continue
    const id = runtime === 'JVM JAR' ? 'nasa-live-jvm' : 'nasa-live-dex'
    const saved = JSON.parse(await readFile(sourceFile, 'utf8'))
    saved.push({ id, name: 'NASA acceptance ' + runtime, enabled: true, type: 'type3', runtime: 'jvm', apiUrl: 'csp_Nasa',
      jarPath: process.env[variable] })
    await writeFile(sourceFile, JSON.stringify(saved))
    cases.push({ id, runtime, ui: false })
  }
  for (const entry of cases) {
    const caseDir = path.join(files, entry.id)
    await mkdir(caseDir)
    await api('/api/downloads/settings', { downloadDir: caseDir })
    const search = await api('/api/video-sources/search?sourceId=' + entry.id + '&keyword=Artemis')
    assert.ok(search.items.length, entry.runtime + ' search is empty')
    const item = search.items[0]
    const detail = await api('/api/video-sources/detail?sourceId=' + entry.id + '&videoId=' + encodeURIComponent(item.id))
    assert.equal(detail.id, item.id)
    assert.ok(detail.lines[0]?.episodes.length)
    const selection = { sourceId: entry.id, videoId: item.id, lineIndex: 0, episodeIndex: 0 }
    const media = await api('/api/video-sources/resolve', selection)
    assert.match(media.url, /^https:\/\/images-assets\.nasa\.gov\//)
    let task
    if (entry.ui) {
      await page.getByLabel('影视名称').fill('Artemis')
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await page.getByRole('button', { name: '查看剧集', exact: true }).click({ timeout: 90000 })
      await page.getByRole('button', { name: 'Preview · 解析并下载', exact: true }).click({ timeout: 90000 })
      await page.getByText('已加入下载任务：', { exact: false }).waitFor({ timeout: 90000 })
      task = (await api('/api/downloads/active')).tasks.find(t => t.fileName.startsWith(item.title))
    } else task = await api('/api/video-sources/download', selection)
    assert.ok(task?.gid)
    let completed
    for (let i = 0; i < 180; i++) {
      const current = (await api('/api/downloads/active')).tasks.find(t => t.gid === task.gid)
      assert.notEqual(current?.status, 'error', current?.errorMessage)
      if (current?.status === 'complete') { completed = current; break }
      await delay(1000)
    }
    assert.ok(completed, entry.runtime + ' download timed out')
    const target = path.join(caseDir, completed.fileName)
    const ffmpeg = process.env.NETPAN_QA_FFMPEG || path.join(root, 'resources/ffmpeg/win/ffmpeg.exe')
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', target, '-t', '1', '-f', 'null', '-'], { windowsHide: true })
    const result = { runtime: entry.runtime, keyword: 'Artemis', searchCount: search.items.length,
      videoId: item.id, title: item.title, detailMatched: true, mediaUrl: media.url,
      output: target, gid: completed.gid, bytes: (await stat(target)).size, completedLength: completed.completedLength, decoded: true, uiDownload: entry.ui }
    report.results.push(result)
    console.log(JSON.stringify(result))
  }
  // A separate explicit fixture verifies parse=1 through the desktop's hidden Chromium page.
  const browserRule = `export default {
    search(){return {list:[{vod_id:'html-demo',vod_name:'HTML parser fixture'}]};},
    detail(id){return {list:[{vod_id:id,vod_name:'HTML parser fixture',vod_play_from:'HTML',vod_play_url:'Video$html-demo'}]};},
    play(){return {parse:1,url:'https://www.w3schools.com/html/html5_video.asp'};}
  }`
  const browserDir = path.join(files, 'browser-parser')
  await mkdir(browserDir)
  await api('/api/downloads/settings', { downloadDir: browserDir })
  const browserImport = await api('/api/video-sources/import-tvbox', { config: { sites: [
    { key: 'browser-fixture', name: 'HTML browser parser acceptance', type: 3,
      api: 'https://httpbingo.org/base64/' + encodeURIComponent(Buffer.from(browserRule).toString('base64')) }
  ] } })
  const browserSource = browserImport.sources.find(s => s.key === 'browser-fixture')
  assert.ok(browserSource)
  const selection = { sourceId: browserSource.id, videoId: 'html-demo', lineIndex: 0, episodeIndex: 0 }
  const browserMedia = await api('/api/video-sources/resolve', selection)
  assert.match(browserMedia.url, /^https:\/\/www\.w3schools\.com\/html\/mov_bbb\.mp4/)
  const browserTask = await api('/api/video-sources/download', selection)
  let finished
  for (let i = 0; i < 90; i++) {
    const current = (await api('/api/downloads/active')).tasks.find(t => t.gid === browserTask.gid)
    assert.notEqual(current?.status, 'error', current?.errorMessage)
    if (current?.status === 'complete') { finished = current; break }
    await delay(1000)
  }
  assert.ok(finished, 'browser parse=1 download did not finish')
  const target = path.join(browserDir, finished.fileName)
  execFileSync(process.env.NETPAN_QA_FFMPEG || path.join(root, 'resources/ffmpeg/win/ffmpeg.exe'),
    ['-nostdin', '-v', 'error', '-i', target, '-t', '1', '-f', 'null', '-'], { windowsHide: true })
  report.browserParser = { fixture: true, parse: 1, url: browserMedia.url, output: target, bytes: (await stat(target)).size, decoded: true }
  console.log('Browser parse=1:', JSON.stringify(report.browserParser))
  const hlsDir = path.join(files, 'hls-player')
  await mkdir(hlsDir)
  await api('/api/downloads/settings', { downloadDir: hlsDir })
  const hlsRule = `export default {
    detail(id){return {list:[{vod_id:id,vod_name:'Type3 HLS fixture',vod_play_from:'HLS',vod_play_url:'Sample$opaque-hls'}]};},
    play(){return {parse:0,format:'m3u8',url:'https://test-streams.mux.dev/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8'};}
  }`
  const hlsImported = await api('/api/video-sources/import-tvbox', { config: { sites: [
    { key: 'hls-player-fixture', name: 'Type3 HLS acceptance', type: 3,
      api: 'https://httpbingo.org/base64/' + encodeURIComponent(Buffer.from(hlsRule).toString('base64')) }
  ] } })
  const hlsSource = hlsImported.sources.find(s => s.key === 'hls-player-fixture')
  const hlsTask = await api('/api/video-sources/download', { sourceId: hlsSource.id, videoId: 'mux', lineIndex: 0, episodeIndex: 0 })
  let hlsComplete
  for (let i = 0; i < 180; i++) {
    const current = (await api('/api/downloads/active')).tasks.find(t => t.gid === hlsTask.gid)
    assert.notEqual(current?.status, 'error', current?.errorMessage)
    if (current?.status === 'complete') { hlsComplete = current; break }
    await delay(1000)
  }
  assert.ok(hlsComplete, 'Type3 HLS download did not finish')
  const hlsFile = path.join(hlsDir, hlsComplete.fileName)
  execFileSync(process.env.NETPAN_QA_FFMPEG || path.join(root, 'resources/ffmpeg/win/ffmpeg.exe'),
    ['-nostdin', '-v', 'error', '-i', hlsFile, '-t', '1', '-f', 'null', '-'], { windowsHide: true })
  report.hlsPlayer = { fixture: true, output: hlsFile, bytes: (await stat(hlsFile)).size, decoded: true }
  console.log('Type3 HLS player:', JSON.stringify(report.hlsPlayer))
  // Actual original source: importing it must never be counted as execution success.
  const imported = await api('/api/video-sources/import-tvbox-url', { url: 'https://9280.kstore.vip/newwex.json' })
  const wex = imported.sources.find(s => s.apiUrl === 'csp_AiNewHuaJuanGuard') || imported.sources.find(s => s.apiUrl?.startsWith('csp_'))
  assert.ok(wex)
  const response = await page.request.get(origin + '/api/video-sources/search?sourceId=' + wex.id + '&keyword=' + encodeURIComponent('三体'), { timeout: 90000 })
  const outcome = await response.json()
  report.newwex = { imported: imported.imported, api: wex.apiUrl, response: outcome }
  console.log('newwex actual execution:', JSON.stringify(report.newwex))
  try {
    const ft = await api('/api/video-sources/import-tvbox-url', { url: 'http://www.xn--sss604efuw.net/tv' })
    const huya = ft.sources.find(s => s.name.includes('虎牙') && s.runtime === 'javascript')
    if (huya) {
      const home = await page.request.get(origin + '/api/video-sources/test?sourceId=' + huya.id, { timeout: 180000 })
      const search = await page.request.get(origin + '/api/video-sources/search?sourceId=' + huya.id + '&keyword=' + encodeURIComponent('英雄联盟'), { timeout: 180000 })
      report.fantaiying = { imported: ft.imported, source: huya.name, apiUrl: huya.apiUrl, ext: huya.ext,
        home: await home.json(), search: await search.json() }
      console.log('Original FTY drpy source:', JSON.stringify(report.fantaiying))
    }
  } catch (error) { report.fantaiying = { error: String(error) }; console.log('FTY diagnostic failed:', String(error)) }
} catch (error) {
  report.error = String(error?.stack || error)
  process.exitCode = 1
  console.error(report.error)
} finally {
  await writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2))
  if (cdp) try { await Promise.race([cdp.send('Browser.close'), delay(2000)]) } catch {}
  await delay(1000)
  if (child.exitCode === null && child.pid) try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  if (browser) await browser.close().catch(() => {})
  console.log('Live evidence:', path.join(scratch, 'report.json'))
}
