import { config } from '../config.js'
import { AppError } from '../http.js'

interface Aria2RpcError {
  code?: number
  message?: string
}

interface Aria2RpcResponse<T> {
  result?: T
  error?: Aria2RpcError
}

interface Aria2TaskFile {
  path?: string
}

export interface Aria2TaskPayload {
  gid: string
  status: string
  totalLength?: string
  completedLength?: string
  downloadSpeed?: string
  dir?: string
  files?: Aria2TaskFile[]
}

const taskKeys = ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'dir', 'files']

function getAria2Env() {
  return {
    enabled: String(process.env.ARIA2_ENABLED || '').toLowerCase() === 'true',
    rpcUrl: String(process.env.ARIA2_RPC_URL || '').trim(),
    rpcSecret: String(process.env.ARIA2_RPC_SECRET || '').trim(),
    errorMessage:
      String(process.env.ARIA2_ERROR_MESSAGE || '').trim() ||
      '内置下载器不可用：未找到 aria2c.exe'
  }
}

function requireAria2() {
  const env = getAria2Env()
  if (!env.enabled || !env.rpcUrl || !env.rpcSecret) {
    throw new AppError('aria2_unavailable', env.errorMessage, 503)
  }
  return env
}

function normalizeRpcError(method: string, error: unknown) {
  if (error instanceof AppError) {
    throw error
  }

  if (error instanceof Error) {
    throw new AppError('aria2_rpc_failed', `${method} failed: ${error.message}`, 502)
  }

  throw new AppError('aria2_rpc_failed', `${method} failed`, 502)
}

async function callAria2<T>(method: string, params: unknown[] = []): Promise<T> {
  const env = requireAria2()

  try {
    const response = await fetch(env.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${Date.now()}`,
        method: `aria2.${method}`,
        params: [`token:${env.rpcSecret}`, ...params]
      })
    })

    if (!response.ok) {
      throw new AppError('aria2_rpc_failed', `aria2 RPC returned HTTP ${response.status}`, 502)
    }

    const payload = (await response.json()) as Aria2RpcResponse<T>
    if (payload.error) {
      throw new AppError(
        'aria2_rpc_failed',
        payload.error.message || `${method} failed`,
        502
      )
    }

    if (typeof payload.result === 'undefined') {
      throw new AppError('aria2_rpc_failed', `${method} returned an empty result`, 502)
    }

    return payload.result
  } catch (error) {
    normalizeRpcError(method, error)
    throw error
  }
}

export function getAria2Availability() {
  const env = getAria2Env()
  return {
    enabled: env.enabled && Boolean(env.rpcUrl && env.rpcSecret),
    message: env.errorMessage
  }
}

export function getAria2TaskKeys() {
  return [...taskKeys]
}

export function aria2AddUri(
  url: string,
  options: Record<string, string>
) {
  return callAria2<string>('addUri', [[url], options])
}

export function aria2TellActive() {
  return callAria2<Aria2TaskPayload[]>('tellActive', [taskKeys])
}

export function aria2TellWaiting(offset = 0, num = 20) {
  return callAria2<Aria2TaskPayload[]>('tellWaiting', [offset, num, taskKeys])
}

export function aria2TellStopped(offset = 0, num = 20) {
  return callAria2<Aria2TaskPayload[]>('tellStopped', [offset, num, taskKeys])
}

export function aria2TellStatus(gid: string) {
  return callAria2<Aria2TaskPayload>('tellStatus', [gid, taskKeys])
}

export function aria2Pause(gid: string) {
  return callAria2<string>('pause', [gid])
}

export function aria2Unpause(gid: string) {
  return callAria2<string>('unpause', [gid])
}

export function aria2Remove(gid: string) {
  return callAria2<string>('remove', [gid])
}

export function aria2RemoveDownloadResult(gid: string) {
  return callAria2<string>('removeDownloadResult', [gid])
}

export function getDefaultAria2RpcUrl() {
  return `http://127.0.0.1:16800/jsonrpc`
}

export function getDefaultDownloadOptions(out?: string, dir?: string) {
  return {
    out: out || '',
    dir: dir || '',
    split: '16',
    'max-connection-per-server': '16',
    continue: 'true'
  }
}
