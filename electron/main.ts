import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import type { Server } from 'node:http'
import type { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..', '..')
const distServerEntry = path.resolve(appRoot, 'dist-server', 'server', 'index.js')
const preloadEntry = path.resolve(__dirname, 'preload.js')
const defaultBackendPort = 3000
const aria2RpcPort = 16800
let backendPort = defaultBackendPort

let mainWindow: BrowserWindow | null = null
let backendServer: Server | null = null
let aria2Process: ChildProcessByStdio<null, Readable, Readable> | null = null
let backendLogs = ''
let aria2Logs = ''
let appQuitting = false

function appendBackendLog(chunk: string) {
  backendLogs = `${backendLogs}${chunk}`.slice(-4000)
}

function appendAria2Log(chunk: string) {
  aria2Logs = `${aria2Logs}${chunk}`.slice(-4000)
}

async function ensureServerBuildExists() {
  await access(distServerEntry, fsConstants.R_OK)
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
    setAria2Disabled('未找到 aria2c.exe，请将 aria2c.exe 放到 resources/aria2/win/aria2c.exe')
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
  await startBackend()
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  appQuitting = true
})

app.whenReady().then(async () => {
  try {
    await bootstrapDesktop()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Desktop bootstrap failed'
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
