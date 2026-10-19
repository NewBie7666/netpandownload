import { BrowserWindow, session } from 'electron'
import { browserFileLinks, parseBrowserExtensions, type BrowserScanResult } from './interactivePageLinks.js'

let browser: BrowserWindow | null = null
const capturedUrls = new Set<string>()
const scanPartition = 'persist:netpan-page-link-scanner'
let downloadListenerInstalled = false

function isBrowserUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 8192) return false
  try {
    const u = new URL(raw)
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname) &&
      !u.username && !u.password
  } catch { return false }
}

function rememberCandidate(url: string) {
  if (!isBrowserUrl(url)) return
  if (capturedUrls.size >= 1000) return
  capturedUrls.add(url)
}

function ensureScanWindow() {
  if (browser && !browser.isDestroyed()) return browser
  const scanSession = session.fromPartition(scanPartition)
  if (!downloadListenerInstalled) {
    // Never download arbitrary files through Chromium while discovering links.
    // Keep the chosen URL so the user can explicitly submit it to aria2.
    scanSession.on('will-download', (_event, item) => {
      rememberCandidate(item.getURL())
      item.cancel()
    })
    downloadListenerInstalled = true
  }
  browser = new BrowserWindow({
    width: 1100,
    height: 800,
    title: '网页交互扫描器（手动展开详情后回主窗口扫描）',
    autoHideMenuBar: true,
    webPreferences: {
      partition: scanPartition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
      // No preload: arbitrary websites cannot access desktopApi.
    }
  })
  browser.webContents.setWindowOpenHandler(({ url }) => {
    // Capture dynamically created direct download URLs opened in a new tab.
    rememberCandidate(url)
    return { action: 'deny' }
  })
  browser.webContents.on('will-navigate', (event, url) => {
    if (!isBrowserUrl(url)) event.preventDefault()
    if (/\.(pkg|json)(?:[?#]|$)/i.test(url)) {
      rememberCandidate(url)
      event.preventDefault()
    }
  })
  browser.on('closed', () => { browser = null })
  return browser
}

export async function openPageScanBrowser(input: unknown) {
  if (!isBrowserUrl(input)) throw new Error('请输入有效的 HTTP/HTTPS 网页地址')
  const win = ensureScanWindow()
  capturedUrls.clear()
  await win.loadURL(input)
  win.show()
  win.focus()
  return { pageUrl: win.webContents.getURL() }
}

export async function scanInteractivePage(input: unknown): Promise<BrowserScanResult> {
  const extensions = parseBrowserExtensions(input)
  if (!browser || browser.isDestroyed()) {
    throw new Error('请先点击“打开交互网页”，在网页中展开文件详情')
  }

  // Only inspect the DOM already rendered in a separately sandboxed Electron
  // window. Do not execute user-provided code or synthesize clicks.
  const snapshot = await browser.webContents.executeJavaScript(String.raw`(() => {
    const urls = []
    const nodes = document.querySelectorAll(
      'a[href],img[src],video[src],audio[src],source[src],[data-href],[data-url],[data-download-url]'
    )
    for (const el of Array.from(nodes).slice(0, 5000)) {
      for (const attr of ['href', 'src', 'data-href', 'data-url', 'data-download-url']) {
        const value = el.getAttribute(attr)
        if (value) urls.push(value)
      }
    }
    return { pageUrl: location.href, urls }
  })()`, true) as { pageUrl: string, urls: string[] }

  const links = [...snapshot.urls, ...capturedUrls]
  return browserFileLinks(snapshot.pageUrl, links, extensions)
}
