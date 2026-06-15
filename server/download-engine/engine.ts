import { pauseDownloadTask, removeDownloadTask, resumeDownloadTask } from '../downloader/downloadService.js'
import { AppError } from '../http.js'
import { recoverEngineState } from './recovery.js'
import { syncEngineTasks } from './executionSync.js'
import { maxConcurrent, scheduleDownloads } from './scheduler.js'
import {
  createTask,
  getTask,
  listEvents,
  listTasks,
  requireTask,
  transitionTask
} from './taskManager.js'
import type {
  DownloadEngineActionRequest,
  DownloadEngineAddRequest,
  DownloadEngineAddResult,
  DownloadEngineListResult,
  DownloadEngineActionResult
} from './taskTypes.js'

const syncIntervalMs = 2000
let loopStarted = false
let engineStarted: Promise<void> | undefined

function startLoop() {
  if (loopStarted) return
  loopStarted = true
  setInterval(() => {
    void runEngineTick()
  }, syncIntervalMs).unref()
}

async function runEngineTick() {
  await syncEngineTasks()
  await scheduleDownloads()
}

export async function ensureEngineStarted() {
  if (!engineStarted) {
    engineStarted = recoverEngineState()
      .then(() => {
        startLoop()
      })
      .catch((error) => {
        engineStarted = undefined
        throw error
      })
  }
  await engineStarted
}

function requireAction(action: unknown) {
  if (action === 'pause' || action === 'resume' || action === 'remove') {
    return action
  }
  throw new AppError('download_engine_invalid_action', '不支持的下载任务操作')
}

export async function addEngineTask(input: DownloadEngineAddRequest): Promise<DownloadEngineAddResult> {
  await ensureEngineStarted()
  const task = createTask(input)
  void runEngineTick()
  return {
    id: task.id,
    status: task.status
  }
}

export async function listEngineTasks(): Promise<DownloadEngineListResult> {
  await ensureEngineStarted()
  await runEngineTick()
  return {
    tasks: listTasks(),
    events: listEvents(),
    maxConcurrent
  }
}

export async function controlEngineTask(input: DownloadEngineActionRequest): Promise<DownloadEngineActionResult> {
  await ensureEngineStarted()
  const action = requireAction(input.action)
  const task = requireTask(String(input.id || ''))

  if (action === 'pause') {
    if (task.status === 'queued' || task.status === 'pending') {
      const updated = transitionTask(task.id, 'paused', 'pause')
      return { id: updated.id, status: updated.status }
    }
    if (task.status === 'running' && task.gid) {
      await pauseDownloadTask(task.gid)
      const updated = transitionTask(task.id, 'paused', 'pause')
      return { id: updated.id, status: updated.status }
    }
    return { id: task.id, status: task.status }
  }

  if (action === 'resume') {
    if (task.status !== 'paused') {
      return { id: task.id, status: task.status }
    }
    if (task.gid) {
      await resumeDownloadTask(task.gid)
      const updated = transitionTask(task.id, 'running', 'resume')
      void runEngineTick()
      return { id: updated.id, status: updated.status }
    }
    const updated = transitionTask(task.id, 'queued', 'resume')
    void runEngineTick()
    return { id: updated.id, status: updated.status }
  }

  if (task.gid && task.status !== 'removed') {
    await removeDownloadTask(task.gid, { deleteFile: false })
  }
  const current = getTask(task.id)
  if (!current || current.status === 'removed') {
    return { id: task.id, status: 'removed' }
  }
  const updated = transitionTask(task.id, 'removed', 'remove')
  void runEngineTick()
  return { id: updated.id, status: updated.status }
}
