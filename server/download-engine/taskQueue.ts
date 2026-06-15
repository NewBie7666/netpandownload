import { listTasks } from './taskManager.js'

export function getNextQueuedTasks(limit: number) {
  if (limit <= 0) return []
  return listTasks()
    .filter((task) => task.status === 'queued')
    .slice(0, limit)
}
