import { randomUUID } from 'node:crypto'
import { AppError } from '../http.js'
import type {
  DownloadEngineAddRequest,
  DownloadEngineEvent,
  DownloadEngineTask,
  EngineTaskStatus
} from './taskTypes.js'

const tasks = new Map<string, DownloadEngineTask>()
const taskEventLog: DownloadEngineEvent[] = []
const maxEventLogSize = 200

function now() {
  return Date.now()
}

function cloneTask(task: DownloadEngineTask): DownloadEngineTask {
  return { ...task }
}

function appendEvent(
  taskId: string,
  action: string,
  fromState: EngineTaskStatus,
  toState: EngineTaskStatus
) {
  taskEventLog.push({
    taskId,
    action,
    fromState,
    toState,
    timestamp: now()
  })

  if (taskEventLog.length > maxEventLogSize) {
    taskEventLog.splice(0, taskEventLog.length - maxEventLogSize)
  }
}

export function createTask(input: DownloadEngineAddRequest) {
  const downloadUrl = String(input.proxyUrl || input.downloadUrl || '').trim()
  if (!downloadUrl) {
    throw new AppError('download_engine_missing_url', '缺少可执行下载地址')
  }

  const createdAt = now()
  const task: DownloadEngineTask = {
    id: randomUUID(),
    providerId: input.providerId,
    sourceUrl: String(input.sourceUrl || '').trim(),
    episodeId: String(input.episodeId || '').trim(),
    fileName: String(input.fileName || '').trim() || 'download',
    downloadUrl,
    status: 'queued',
    createdAt,
    updatedAt: createdAt
  }
  tasks.set(task.id, task)
  appendEvent(task.id, 'create', 'queued', 'queued')
  return cloneTask(task)
}

export function getTask(id: string) {
  const task = tasks.get(id)
  return task ? cloneTask(task) : undefined
}

export function requireTask(id: string) {
  const task = getTask(id)
  if (!task) {
    throw new AppError('download_engine_task_missing', '下载任务不存在', 404)
  }
  return task
}

export function listTasks() {
  return Array.from(tasks.values())
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(cloneTask)
}

export function listEvents() {
  return taskEventLog.map((event) => ({ ...event }))
}

export function transitionTask(
  id: string,
  toState: EngineTaskStatus,
  action: string,
  patch: Partial<Pick<DownloadEngineTask, 'gid' | 'error'>> = {}
) {
  const task = tasks.get(id)
  if (!task) {
    throw new AppError('download_engine_task_missing', '下载任务不存在', 404)
  }

  const fromState = task.status
  task.status = toState
  task.updatedAt = now()
  if ('gid' in patch) {
    task.gid = patch.gid
  }
  if ('error' in patch) {
    task.error = patch.error
  }
  appendEvent(id, action, fromState, toState)
  return cloneTask(task)
}

export function setTaskGid(id: string, gid: string) {
  const task = tasks.get(id)
  if (!task) {
    throw new AppError('download_engine_task_missing', '下载任务不存在', 404)
  }
  task.gid = gid
  task.updatedAt = now()
  return cloneTask(task)
}

export function countTasksByStatus(statuses: EngineTaskStatus[]) {
  const wanted = new Set(statuses)
  return Array.from(tasks.values()).filter((task) => wanted.has(task.status)).length
}
