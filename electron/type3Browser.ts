import { BrowserWindow, session } from 'electron'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'

export interface Type3BrowserMedia { url: string; headers: Record<string, string>; kind: 'hls' | 'mp4' }

export async function resolveType3BrowserMedia(
  url: string,
  headers: Record<string, string>,
  validateUrl: (value: string) => URL,
  publicAddress: (value: string) => boolean
): Promise<Type3BrowserMedia> {
  validateUrl(url)
  const browserSession = session.fromPartition('type3-' + randomUUID())
  if (headers['User-Agent']) browserSession.setUserAgent(headers['User-Agent'])
  const browser = new BrowserWindow({
    show: false,
    webPreferences: { session: browserSession, sandbox: true, nodeIntegration: false, contextIsolation: true,
      webSecurity: true, allowRunningInsecureContent: false }
  })
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return new Promise((resolve, reject) => {
    let settled = false
    let requests = 0
    const requestHeaders = new Map<number, Record<string, string>>()
    const timeout = setTimeout(() => finish(new Error('网页解析在 30 秒内未发现可下载的 MP4/HLS 媒体')), 30_000)
    function finish(error?: Error, media?: Type3BrowserMedia) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      browserSession.webRequest.onBeforeRequest(null)
      browserSession.webRequest.onBeforeSendHeaders(null)
      browserSession.webRequest.onHeadersReceived(null)
      if (!browser.isDestroyed()) browser.destroy()
      void browserSession.clearStorageData().catch(() => {})
      if (error) reject(error)
      else if (media) resolve(media)
    }
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      void (async () => {
        if (++requests > 250) throw new Error('网页解析请求数超过上限')
        // Player pages create srcdoc/about:blank frames and blob media. These
        // do not open network sockets; their HTTP subrequests are checked below.
        if (/^(?:about:(?:blank|srcdoc)$|data:|blob:)/i.test(details.url)) {
          callback({ cancel: false })
          return
        }
        const target = validateUrl(details.url)
        const host = target.hostname.replace(/^\[|\]$/g, '')
        const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('网页解析请求指向非公网地址')
        callback({ cancel: false })
      })().catch(() => callback({ cancel: true }))
    })
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const target = new URL(details.url)
      if (!['http:', 'https:'].includes(target.protocol)) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      const sourceHost = new URL(url).hostname
      const applied = { ...details.requestHeaders }
      for (const [name, value] of Object.entries(headers)) {
        if (['Cookie', 'Authorization'].includes(name) && target.hostname !== sourceHost) continue
        applied[name] = value
      }
      requestHeaders.set(details.id, applied)
      callback({ requestHeaders: applied })
    })
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      const contentType = Object.entries(details.responseHeaders || {})
        .find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.join(' ') || ''
      const media = /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl|video\/mp4/i.test(contentType)
      callback({ cancel: media })
      if (media && details.statusCode >= 200 && details.statusCode < 300) {
        const captured: Record<string, string> = {}
        for (const [name, value] of Object.entries(requestHeaders.get(details.id) || {})) {
          if (/^(user-agent|referer|origin|cookie|authorization)$/i.test(name)) captured[name] = value
        }
        finish(undefined, { url: details.url, headers: captured, kind: /mpegurl/i.test(contentType) ? 'hls' : 'mp4' })
      }
    })
    browser.webContents.on('render-process-gone', () => finish(new Error('网页解析进程已退出')))
    void browser.loadURL(url).catch(() => { /* Media interception can cancel navigation. */ })
  })
}
