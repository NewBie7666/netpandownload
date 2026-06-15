import type { DownloadTaskStatus } from '../../shared/types.js'
import { getDownloadTaskStatus } from '../downloader/downloadService.js'
import { listTasks, transitionTask } from './taskManager.js'
import type { EngineTaskStatus } from './taskTypes.js'

function mapAria2Status(status: DownloadTaskStatus): EngineTaskStatus | undefined {
  if (status === 'active' || status === 'waiting') return 'running'
  if (status === 'paused') return 'paused'
  if (status === 'complete') return 'done'
  if (status === 'error') return 'error'
  if (status === 'removed') return 'removed'
  return undefined
}

export async function syncEngineTasks() {
  const tasks = listTasks().filter((task) => task.gid && ['running', 'paused'].includes(task.status))

  await Promise.all(
    tasks.map(async (task) => {
      try {
        const ariaTask = await getDownloadTaskStatus(task.gid || '')
        const nextStatus = mapAria2Status(ariaTask.status)
        if (nextStatus && nextStatus !== task.status) {
          transitionTask(task.id, nextStatus, 'aria2_sync', {
            error: nextStatus === 'error' ? 'aria2 任务失败' : undefined
          })
        }
      } catch (error) {
        transitionTask(task.id, 'error', 'aria2_sync_error', {
          error: error instanceof Error ? error.message : '同步下载任务状态失败'
        })
      }
    })
  )
}
