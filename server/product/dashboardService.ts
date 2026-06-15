import type { DownloadDashboard, UnifiedTask } from '../../shared/types.js'

function taskKey(task: UnifiedTask) {
  return task.gid || task.id
}

export function buildDashboard(tasks: UnifiedTask[], history: UnifiedTask[]): DownloadDashboard {
  const taskMap = new Map<string, UnifiedTask>()
  for (const task of [...history, ...tasks]) {
    taskMap.set(taskKey(task), task)
  }
  const allTasks = Array.from(taskMap.values())

  return {
    totalTasks: allTasks.length,
    runningCount: tasks.filter((task) => task.status === 'running').length,
    pausedCount: tasks.filter((task) => task.status === 'paused').length,
    completedCount: allTasks.filter((task) => task.status === 'done').length,
    failedCount: allTasks.filter((task) => task.status === 'error').length,
    removedCount: allTasks.filter((task) => task.status === 'removed').length,
    activeDownloads: tasks.filter((task) => task.status === 'running').length
  }
}
