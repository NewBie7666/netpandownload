import type { App, BrowserWindow } from 'electron'
import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'

export interface CrashLogEntry {
  timestamp: string
  level: 'info' | 'error' | 'fatal'
  layer: 'main' | 'renderer' | 'gpu' | 'child-process' | 'runtime-health'
  message: string
  meta?: Record<string, unknown>
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  }
  return { message: String(error || 'unknown error') }
}

function getCrashLogPath(app: App) {
  try {
    return path.join(app.getPath('userData'), 'logs', 'crash.log')
  } catch {
    return path.join(process.cwd(), 'logs', 'crash.log')
  }
}

export function writeCrashLog(app: App, entry: CrashLogEntry) {
  const logPath = getCrashLogPath(app)
  const line = `${JSON.stringify(entry)}\n`
  void mkdir(path.dirname(logPath), { recursive: true })
    .then(() => appendFile(logPath, line, 'utf8'))
    .catch(() => undefined)
}

export function installReleaseCrashHandler(app: App) {
  process.on('uncaughtException', (error) => {
    writeCrashLog(app, {
      timestamp: new Date().toISOString(),
      level: 'fatal',
      layer: 'main',
      message: error.message,
      meta: serializeError(error)
    })
  })

  process.on('unhandledRejection', (reason) => {
    writeCrashLog(app, {
      timestamp: new Date().toISOString(),
      level: 'error',
      layer: 'main',
      message: reason instanceof Error ? reason.message : String(reason || 'unhandled rejection'),
      meta: serializeError(reason)
    })
  })

  app.on('render-process-gone', (_event, webContents, details) => {
    writeCrashLog(app, {
      timestamp: new Date().toISOString(),
      level: 'error',
      layer: 'renderer',
      message: `Renderer process gone: ${details.reason}`,
      meta: {
        reason: details.reason,
        exitCode: details.exitCode,
        url: webContents.getURL()
      }
    })
  })

  app.on('child-process-gone', (_event, details) => {
    writeCrashLog(app, {
      timestamp: new Date().toISOString(),
      level: details.type === 'GPU' ? 'fatal' : 'error',
      layer: details.type === 'GPU' ? 'gpu' : 'child-process',
      message: `Child process gone: ${details.reason}`,
      meta: {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName
      }
    })
  })
}

export function attachWindowCrashRecovery(
  app: App,
  window: BrowserWindow,
  recover: () => void
) {
  window.webContents.on('render-process-gone', (_event, details) => {
    writeCrashLog(app, {
      timestamp: new Date().toISOString(),
      level: 'error',
      layer: 'renderer',
      message: `Renderer crashed: ${details.reason}`,
      meta: {
        reason: details.reason,
        exitCode: details.exitCode
      }
    })

    setTimeout(() => {
      try {
        recover()
      } catch (error) {
        writeCrashLog(app, {
          timestamp: new Date().toISOString(),
          level: 'error',
          layer: 'renderer',
          message: 'Renderer recovery failed',
          meta: serializeError(error)
        })
      }
    }, 500)
  })
}
