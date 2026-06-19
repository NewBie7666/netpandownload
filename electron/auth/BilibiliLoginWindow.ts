import { BrowserWindow, type Cookie } from 'electron'
import { formatBilibiliCookie, isValidBilibiliCookie } from './bilibiliCookieStore.js'

export interface BilibiliLoginResult {
  status: 'success' | 'failed' | 'cancelled'
  loggedIn: boolean
  cookie?: string
  message?: string
}

const loginUrl = 'https://passport.bilibili.com/login'
const loginTimeoutMs = 5 * 60 * 1000

async function readBilibiliCookies(win: BrowserWindow) {
  const session = win.webContents.session
  const scopedCookies: Cookie[] = [
    ...(await session.cookies.get({ domain: '.bilibili.com' })),
    ...(await session.cookies.get({ url: 'https://www.bilibili.com' }))
  ]

  const cookie = formatBilibiliCookie(scopedCookies)
  return isValidBilibiliCookie(cookie) ? cookie : ''
}

export function openBilibiliLoginWindow(parent?: BrowserWindow | null): Promise<BilibiliLoginResult> {
  return new Promise((resolve) => {
    let settled = false
    let pollTimer: NodeJS.Timeout | undefined
    let timeoutTimer: NodeJS.Timeout | undefined

    const win = new BrowserWindow({
      width: 420,
      height: 700,
      parent: parent || undefined,
      modal: false,
      title: 'B站登录',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:bilibili',
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    function cleanup() {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }
    }

    function finish(result: BilibiliLoginResult) {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
      if (!win.isDestroyed()) {
        win.close()
      }
    }

    async function checkLogin() {
      if (settled || win.isDestroyed()) {
        return
      }

      try {
        const cookie = await readBilibiliCookies(win)
        if (cookie) {
          finish({
            status: 'success',
            loggedIn: true,
            cookie,
            message: 'B站登录成功'
          })
        }
      } catch {
        // Keep polling. A transient cookie read failure should not fail login.
      }
    }

    win.on('closed', () => {
      cleanup()
      if (!settled) {
        settled = true
        resolve({
          status: 'cancelled',
          loggedIn: false,
          message: '已取消 B站登录'
        })
      }
    })

    win.webContents.on('did-fail-load', (_event, _code, description) => {
      finish({
        status: 'failed',
        loggedIn: false,
        message: description || 'B站登录页加载失败'
      })
    })

    pollTimer = setInterval(() => {
      void checkLogin()
    }, 1200)

    win.webContents.session.cookies.on('changed', () => {
      void checkLogin()
    })

    timeoutTimer = setTimeout(() => {
      finish({
        status: 'failed',
        loggedIn: false,
        message: 'B站登录超时，请重试'
      })
    }, loginTimeoutMs)

    win.loadURL(loginUrl).catch((error) => {
      finish({
        status: 'failed',
        loggedIn: false,
        message: error instanceof Error ? error.message : 'B站登录页加载失败'
      })
    })
  })
}
