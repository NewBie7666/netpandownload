import type { ProductUiTask } from '../../../api/product'

// Unified tasks can also be provider-engine jobs; only real aria2 GIDs can
// be sent to /api/downloads/pause or /api/downloads/resume.
export function getAria2TaskAction(
  task: Pick<ProductUiTask, 'gid' | 'source' | 'status'>
): 'pause' | 'resume' | null {
  if (task.source !== 'aria2' || !task.gid) return null
  if (task.status === 'paused') return 'resume'
  if (task.status === 'active' || task.status === 'waiting') return 'pause'
  return null
}
