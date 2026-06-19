import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import type { Server } from 'node:http'
import type { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openBilibiliLoginWindow } from './auth/BilibiliLoginWindow.js'
import {
  clearBilibiliCookieStore,
  isValidBilibiliCookie,
  loadBilibiliCookie,
  saveBilibiliCookie
} from './auth/bilibiliCookieStore.js'
import {
  attachWindowCrashRecovery,
  installReleaseCrashHandler,
  writeCrashLog
} from './release/crashHandler.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..', '..')
const distServerEntry = path.resolve(appRoot, 'dist-server', 'server', 'index.js')
const preloadEntry = path.resolve(__dirname, 'preload.cjs')
const defaultBackendPort = 3000
const aria2RpcPort = 16800
let backendPort = defaultBackendPort

app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')
installReleaseCrashHandler(app)

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let backendServer: Server | null = null
let aria2Process: ChildProcessByStdio<null, Readable, Readable> | null = null
let backendLogs = ''
let aria2Logs = ''
let appQuitting = false
let bilibiliLastLoginTime: number | undefined

interface BilibiliLoginStatus {
  loggedIn: boolean
  cookieValid: boolean
  lastLoginTime?: number
  mode: 'anonymous' | 'cookie'
}

function appendBackendLog(chunk: string) {
  backendLogs = `${backendLogs}${chunk}`.slice(-4000)
}

function appendAria2Log(chunk: string) {
  aria2Logs = `${aria2Logs}${chunk}`.slice(-4000)
}

async function ensureServerBuildExists() {
  await access(distServerEntry, fsConstants.R_OK)
}

function getBilibiliEnvBridgePath() {
  return path.resolve(appRoot, 'dist-server', 'server', 'providers', 'bilibili', 'auth', 'envBridge.js')
}

function getRuntimeHealthCheckPath() {
  return path.resolve(appRoot, 'dist-server', 'server', 'release', 'runtimeHealthCheck.js')
}

async function runStartupHealthCheck() {
  try {
    const healthModule = await import(pathToFileURL(getRuntimeHealthCheckPath()).href)
    return await healthModule.runRuntimeHealthCheck?.()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeCrashLog(app, {
      timestamp: new Date().toISOString(),
      level: 'error',
      layer: 'runtime-health',
      message: 'Runtime health check could not run',
      meta: { error: message }
    })
    return {
      status: 'FAILED',
      message: 'Runtime health check failed to start',
      checks: {}
    }
  }
}

async function showStartupHealthFailure(message: string) {
  createWindow()
  const safeMessage = message.replace(/[<>&"]/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;'
  })[char] || char)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>Startup check failed</title>
  <style>
    body { margin: 0; font-family: "Microsoft YaHei", Arial, sans-serif; background: #f8fafc; color: #172033; }
    main { max-width: 680px; margin: 96px auto; padding: 32px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 16px; font-size: 24px; }
    p { line-height: 1.7; color: #475569; }
    code { display: block; margin-top: 16px; padding: 12px; background: #f1f5f9; border-radius: 8px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>Startup check failed</h1>
    <p>The app did not enter the normal interface. Restart the app; if the problem continues, check the local logs.</p>
    <code>${safeMessage}</code>
  </main>
</body>
</html>`
  await mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

async function setBilibiliRuntimeCookie(cookie: string) {
  if (!isValidBilibiliCookie(cookie)) {
    await clearBilibiliRuntimeCookie()
    return
  }

  process.env.BILIBILI_COOKIE = cookie
  try {
    const bridge = await import(pathToFileURL(getBilibiliEnvBridgePath()).href)
    bridge.setRuntimeCookie?.(cookie)
  } catch {
    // The server bridge may not be built yet in early startup. process.env remains the fallback channel.
  }
}

async function clearBilibiliRuntimeCookie() {
  delete process.env.BILIBILI_COOKIE
  bilibiliLastLoginTime = undefined
  try {
    const bridge = await import(pathToFileURL(getBilibiliEnvBridgePath()).href)
    bridge.clearRuntimeCookie?.()
  } catch {
    // Best-effort cleanup; process.env is already cleared.
  }
}

async function loadStoredBilibiliCookieIntoRuntime() {
  const stored = await loadBilibiliCookie()
  if (!stored?.cookie || !isValidBilibiliCookie(stored.cookie)) {
    await clearBilibiliRuntimeCookie()
    return
  }

  bilibiliLastLoginTime = stored.lastLoginTime
  await setBilibiliRuntimeCookie(stored.cookie)
}

async function getBilibiliLoginStatus(): Promise<BilibiliLoginStatus> {
  const stored = await loadBilibiliCookie()
  const cookie = stored?.cookie || String(process.env.BILIBILI_COOKIE || '').trim()
  const cookieValid = isValidBilibiliCookie(cookie)

  if (!cookieValid) {
    await clearBilibiliRuntimeCookie()
    return {
      loggedIn: false,
      cookieValid: false,
      mode: 'anonymous'
    }
  }

  bilibiliLastLoginTime = stored?.lastLoginTime || bilibiliLastLoginTime
  await setBilibiliRuntimeCookie(cookie)
  return {
    loggedIn: true,
    cookieValid: true,
    lastLoginTime: bilibiliLastLoginTime,
    mode: 'cookie'
  }
}

async function clearBilibiliSessionCookies() {
  const bilibiliSession = session.fromPartition('persist:bilibili')
  const cookies = await bilibiliSession.cookies.get({})
  await Promise.all(
    cookies
      .filter((cookie) => String(cookie.domain || '').toLowerCase().includes('bilibili.com'))
      .map((cookie) => {
        const domain = String(cookie.domain || 'www.bilibili.com').replace(/^\./, '') || 'www.bilibili.com'
        return bilibiliSession.cookies.remove(`https://${domain}${cookie.path || '/'}`, cookie.name).catch(() => undefined)
      })
  )
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadEntry,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  attachWindowCrashRecovery(app, mainWindow, () => {
    if (!appQuitting && mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(getRendererUrl())
    }
  })
}

function getRendererUrl() {
  const devUrl = process.env.ELECTRON_RENDERER_URL?.trim()
  if (devUrl) {
    return devUrl
  }
  return getBackendUrl()
}

function getBackendUrl() {
  return `http://127.0.0.1:${backendPort}`
}

function getHealthUrl() {
  return `${getBackendUrl()}/api/health`
}

function getAria2ExecutablePath() {
  const candidates = [
    path.resolve(appRoot, 'resources', 'aria2', 'win', 'aria2c.exe'),
    path.resolve(process.resourcesPath, 'aria2', 'win', 'aria2c.exe')
  ]
  return candidates[0] === candidates[1] ? [candidates[0]] : candidates
}

async function resolveAria2Executable() {
  for (const candidate of getAria2ExecutablePath()) {
    try {
      await access(candidate, fsConstants.R_OK)
      return candidate
    } catch {
      // try next candidate
    }
  }
  return ''
}

function setAria2Disabled(message: string) {
  process.env.ARIA2_ENABLED = 'false'
  process.env.ARIA2_RPC_URL = ''
  process.env.ARIA2_RPC_SECRET = ''
  process.env.ARIA2_ERROR_MESSAGE = message
}

async function waitForAria2Ready() {
  const rpcUrl = String(process.env.ARIA2_RPC_URL || '').trim()
  const rpcSecret = String(process.env.ARIA2_RPC_SECRET || '').trim()
  const startedAt = Date.now()

  while (Date.now() - startedAt < 10000) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `${Date.now()}`,
          method: 'aria2.getVersion',
          params: [`token:${rpcSecret}`]
        })
      })

      if (response.ok) {
        return
      }
    } catch {
      // aria2 is still starting
    }

    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  throw new Error(aria2Logs.trim() || `Timed out waiting for aria2 RPC at ${rpcUrl}`)
}

async function startAria2Sidecar() {
  if (aria2Process) {
    return
  }

  const executable = await resolveAria2Executable()
  if (!executable) {
    setAria2Disabled('aria2c.exe not found. Put aria2c.exe at resources/aria2/win/aria2c.exe')
    return
  }

  const rpcSecret = randomBytes(24).toString('hex')
  process.env.ARIA2_RPC_URL = `http://127.0.0.1:${aria2RpcPort}/jsonrpc`
  process.env.ARIA2_RPC_SECRET = rpcSecret
  process.env.ARIA2_ENABLED = 'true'
  process.env.ARIA2_ERROR_MESSAGE = ''

  const child = spawn(
    executable,
    [
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${aria2RpcPort}`,
      `--rpc-secret=${rpcSecret}`,
      '--continue=true',
      '--disable-ipv6=true',
      '--async-dns=false',
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--allow-overwrite=false',
      '--auto-file-renaming=true'
    ],
    {
      cwd: path.dirname(executable),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  aria2Process = child

  child.stdout.on('data', (data) => {
    appendAria2Log(String(data))
  })

  child.stderr.on('data', (data) => {
    appendAria2Log(String(data))
  })

  child.once('exit', (code, signal) => {
    if (aria2Process === child) {
      aria2Process = null
    }

    if (appQuitting) {
      return
    }

    setAria2Disabled(
      aria2Logs.trim() || `aria2c exited unexpectedly with code ${code ?? 'unknown'} signal ${signal ?? 'none'}`
    )
    dialog.showErrorBox('aria2 startup failed', process.env.ARIA2_ERROR_MESSAGE || 'aria2 unavailable')
  })

  try {
    await waitForAria2Ready()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setAria2Disabled(message)
    if (aria2Process === child) {
      aria2Process = null
    }
    child.kill()
    dialog.showErrorBox('aria2 startup failed', message)
  }
}

function isAddressInUse(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EADDRINUSE'
  )
}

async function startBackend() {
  if (backendServer) {
    return
  }

  process.env.QUARK_EMBEDDED_SERVER = 'true'
  process.env.QUARK_DESKTOP_STATIC = process.env.ELECTRON_RENDERER_URL ? 'false' : 'true'
  process.env.QUARK_DESKTOP_ROOT = appRoot
  process.env.NETPAN_DATA_DIR = path.join(app.getPath('userData'), 'data')

  try {
    const serverModule = await import(pathToFileURL(distServerEntry).href)
    const candidatePorts = process.env.ELECTRON_RENDERER_URL
      ? [defaultBackendPort]
      : Array.from({ length: 11 }, (_, index) => defaultBackendPort + index)

    for (const port of candidatePorts) {
      try {
        backendServer = await serverModule.startServer(port)
        backendPort = port
        return
      } catch (error) {
        if (!isAddressInUse(error) || port === candidatePorts[candidatePorts.length - 1]) {
          throw error
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendBackendLog(message)
    throw error
  }
}

async function stopBackend() {
  if (!backendServer) {
    return
  }

  const serverRef = backendServer
  backendServer = null

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      resolve()
    }, 5000)

    serverRef.close(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function stopAria2Sidecar() {
  if (!aria2Process) {
    return
  }

  const processRef = aria2Process
  aria2Process = null

  processRef.kill()

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!processRef.killed) {
        processRef.kill('SIGKILL')
      }
      resolve()
    }, 5000)

    processRef.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function waitForBackendReady() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(getHealthUrl())
      if (response.ok) {
        return
      }
    } catch {
      // backend is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }

  throw new Error(backendLogs.trim() || `Timed out waiting for backend readiness at ${getHealthUrl()}`)
}

async function bootstrapDesktop() {
  await ensureServerBuildExists()
  await loadStoredBilibiliCookieIntoRuntime()
  await startBackend()
  const health = await runStartupHealthCheck()
  if (health?.status === 'FAILED') {
    await showStartupHealthFailure(health.message || 'Runtime health check failed')
    return
  }
  await startAria2Sidecar()
  await waitForBackendReady()
  createWindow()
  await mainWindow?.loadURL(getRendererUrl())
}

ipcMain.handle('select-download-dir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })

  return result.canceled ? null : result.filePaths[0] || null
})

ipcMain.handle('bilibili-login', async () => {
  const result = await openBilibiliLoginWindow(mainWindow)
  if (result.status !== 'success' || !result.cookie || !isValidBilibiliCookie(result.cookie)) {
    return {
      status: result.status,
      loggedIn: false,
      message: result.message || 'B站登录未完成'
    }
  }

  const stored = await saveBilibiliCookie(result.cookie)
  bilibiliLastLoginTime = stored.lastLoginTime
  await setBilibiliRuntimeCookie(stored.cookie)

  return {
    status: 'success',
    loggedIn: true,
    message: 'B站登录成功'
  }
})

ipcMain.handle('bilibili-login-status', async () => {
  return getBilibiliLoginStatus()
})

ipcMain.handle('bilibili-logout', async () => {
  await clearBilibiliCookieStore()
  await clearBilibiliSessionCookies()
  await clearBilibiliRuntimeCookie()
  return {
    loggedIn: false,
    cookieValid: false,
    mode: 'anonymous'
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  appQuitting = true
  writeCrashLog(app, {
    timestamp: new Date().toISOString(),
    level: 'info',
    layer: 'main',
    message: 'Application graceful shutdown started'
  })
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  try {
    await bootstrapDesktop()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Desktop bootstrap failed'
    writeCrashLog(app, {
      timestamp: new Date().toISOString(),
      level: 'error',
      layer: 'main',
      message: 'Desktop startup failed',
      meta: { error: message }
    })
    dialog.showErrorBox('Desktop startup failed', message)
    await stopBackend()
    await stopAria2Sidecar()
    app.quit()
  }
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      await bootstrapDesktop()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Desktop bootstrap failed'
      writeCrashLog(app, {
        timestamp: new Date().toISOString(),
        level: 'error',
        layer: 'main',
        message: 'Desktop activation failed',
        meta: { error: message }
      })
      dialog.showErrorBox('Desktop startup failed', message)
      await stopBackend()
      await stopAria2Sidecar()
      app.quit()
    }
  }
})

app.on('quit', () => {
  void stopBackend()
  void stopAria2Sidecar()
})
