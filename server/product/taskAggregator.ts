import type { DownloadTask, ProviderId, UnifiedTask, UnifiedTaskStatus } from '../../shared/types.js'
import { listDownloadTasks } from '../downloader/downloadService.js'
import { listTasks as listEngineTaskSnapshots } from '../download-engine/taskManager.js'
import type { DownloadEngineTask, EngineTaskStatus } from '../download-engine/taskTypes.js'

function mapAria2Status(status: DownloadTask['status']): UnifiedTaskStatus {
  if (status === 'active' || status === 'waiting') return 'running'
  if (status === 'complete') return 'done'
  return status
}

function engineToUnified(task: DownloadEngineTask): UnifiedTask {
  return {
    id: task.gid || task.id,
    title: task.fileName || task.id,
    providerId: task.providerId,
    status: task.status,
    progress: task.status === 'done' ? 100 : undefined,
    source: 'engine',
    createdAt: task.createdAt,
    gid: task.gid,
    error: task.error
  }
}

function aria2ToUnified(task: DownloadTask): UnifiedTask {
  return {
    id: task.gid,
    title: task.fileName || task.gid,
    providerId: 'unknown',
    status: mapAria2Status(task.status),
    progress: task.progress,
    source: 'aria2',
    createdAt: Date.now(),
    gid: task.gid
  }
}

function primaryKey(task: UnifiedTask) {
  return task.gid || task.id
}

function mergeTask(existing: UnifiedTask | undefined, incoming: UnifiedTask): UnifiedTask {
  if (!existing) return incoming

  const engineTask = existing.source === 'engine' ? existing : incoming.source === 'engine' ? incoming : existing
  const runtimeTask = incoming.source === 'aria2' ? incoming : existing.source === 'aria2' ? existing : incoming

  return {
    ...engineTask,
    id: primaryKey(engineTask),
    title: engineTask.title || runtimeTask.title || engineTask.id,
    providerId: engineTask.providerId || ('unknown' as ProviderId | 'unknown'),
    status: runtimeTask.status || engineTask.status,
    progress: typeof runtimeTask.progress === 'number' ? runtimeTask.progress : engineTask.progress,
    source: engineTask.source,
    createdAt: Math.min(engineTask.createdAt || Date.now(), runtimeTask.createdAt || Date.now()),
    gid: engineTask.gid || runtimeTask.gid,
    error: engineTask.error || runtimeTask.error
  }
}

export async function getUnifiedTasks() {
  const taskMap = new Map<string, UnifiedTask>()

  for (const task of listEngineTaskSnapshots()) {
    const unified = engineToUnified(task)
    const key = primaryKey(unified)
    taskMap.set(key, mergeTask(taskMap.get(key), unified))
  }

  const downloadTasks = await listDownloadTasks().catch(() => ({ tasks: [] as DownloadTask[] }))
  for (const task of downloadTasks.tasks) {
    const unified = aria2ToUnified(task)
    const key = primaryKey(unified)
    taskMap.set(key, mergeTask(taskMap.get(key), unified))
  }

  return Array.from(taskMap.values()).sort((left, right) => right.createdAt - left.createdAt)
}

export function isTerminalStatus(status: EngineTaskStatus | UnifiedTaskStatus) {
  return status === 'done' || status === 'error' || status === 'removed'
}
