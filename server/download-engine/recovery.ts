import type { DownloadTaskStatus } from '../../shared/types.js'
import { getDownloadTaskStatus } from '../downloader/downloadService.js'
import { loadTasks } from './persistence/taskStore.js'
import {
  hydrateTasks,
  listTasks,
  transitionTask
} from './taskManager.js'
import type { EngineTaskStatus } from './taskTypes.js'

let recovered = false
let recovering: Promise<void> | undefined

function mapAria2Status(status: DownloadTaskStatus): EngineTaskStatus | undefined {
  if (status === 'active' || status === 'waiting') return 'running'
  if (status === 'paused') return 'paused'
  if (status === 'complete') return 'done'
  if (status === 'error') return 'error'
  if (status === 'removed') return 'removed'
  return undefined
}

function transitionIfChanged(taskId: string, current: EngineTaskStatus, next: EngineTaskStatus, action: string, error?: string) {
  if (current !== next) {
    transitionTask(taskId, next, action, { error })
  }
}

async function reconcileRecoveredTasks() {
  for (const task of listTasks()) {
    if (task.status === 'pending') {
      transitionTask(task.id, 'queued', 'recovery_pending_to_queued')
      continue
    }

    if (task.status === 'queued' || task.status === 'done' || task.status === 'error' || task.status === 'removed') {
      continue
    }

    if (!task.gid) {
      if (task.status === 'running') {
        transitionTask(task.id, 'error', 'recovery_missing_gid', {
          error: '恢复运行中任务失败：缺少 aria2 gid'
        })
      }
      continue
    }

    try {
      const ariaTask = await getDownloadTaskStatus(task.gid)
      const nextStatus = mapAria2Status(ariaTask.status)
      if (!nextStatus) {
        transitionTask(task.id, 'error', 'recovery_unknown_aria2_status', {
          error: `恢复任务失败：未知 aria2 状态 ${ariaTask.status}`
        })
        continue
      }

      if (task.status === 'running' || task.status === 'paused') {
        transitionIfChanged(task.id, task.status, nextStatus, 'recovery_reconcile')
      }
    } catch (error) {
      transitionTask(task.id, 'error', 'recovery_gid_missing', {
        error: error instanceof Error ? error.message : '恢复任务失败：aria2 gid 不存在'
      })
    }
  }
}

async function runRecovery() {
  const stored = await loadTasks()
  hydrateTasks(stored.tasks, stored.events)
  await reconcileRecoveredTasks()
}

export function recoverEngineState() {
  if (recovered) {
    return Promise.resolve()
  }
  if (recovering) {
    return recovering
  }

  recovering = runRecovery().then(
    () => {
      recovered = true
      recovering = undefined
    },
    (error) => {
      recovering = undefined
      throw error
    }
  )
  return recovering
}
