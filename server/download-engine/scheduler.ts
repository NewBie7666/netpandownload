import { addDownloadTask, removeDownloadTask } from '../downloader/downloadService.js'
import { getNextQueuedTasks } from './taskQueue.js'
import {
  countTasksByStatus,
  getTask,
  transitionTask
} from './taskManager.js'

export const maxConcurrent = 3

let scheduling = false

function getExecutionWindowSize() {
  return countTasksByStatus(['pending', 'running'])
}

async function submitPendingTask(taskId: string) {
  const task = getTask(taskId)
  if (!task || task.status !== 'pending') return

  try {
    const result = await addDownloadTask({
      url: task.downloadUrl,
      fileName: task.fileName
    })

    const current = getTask(taskId)
    if (!current || current.status !== 'pending') {
      await removeDownloadTask(result.gid, { deleteFile: false }).catch(() => undefined)
      return
    }

    transitionTask(taskId, 'running', 'scheduler_submit', {
      gid: result.gid,
      error: undefined
    })
  } catch (error) {
    transitionTask(taskId, 'error', 'scheduler_error', {
      error: error instanceof Error ? error.message : '提交下载任务失败'
    })
  }
}

export async function scheduleDownloads() {
  if (scheduling) return
  scheduling = true
  try {
    const capacity = maxConcurrent - getExecutionWindowSize()
    const queuedTasks = getNextQueuedTasks(capacity)

    for (const task of queuedTasks) {
      transitionTask(task.id, 'pending', 'scheduler_claim')
    }

    await Promise.all(queuedTasks.map((task) => submitPendingTask(task.id)))
  } finally {
    scheduling = false
  }
}
