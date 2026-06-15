import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadHistoryResult, UnifiedTask } from '../../shared/types.js'
import { isTerminalStatus } from './taskAggregator.js'

interface HistoryFile {
  items?: UnifiedTask[]
}

const maxHistoryItems = 500
let writeChain = Promise.resolve()

function getHistoryPath() {
  const dataDir = String(process.env.NETPAN_DATA_DIR || '').trim()
  return path.join(dataDir || path.resolve(process.cwd(), 'data'), 'download-history.json')
}

function historyKey(task: UnifiedTask) {
  return task.gid || task.id
}

async function readHistoryFile(): Promise<UnifiedTask[]> {
  try {
    const content = await readFile(getHistoryPath(), 'utf8')
    const parsed = JSON.parse(content) as HistoryFile
    return Array.isArray(parsed.items) ? parsed.items : []
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function writeHistoryFile(items: UnifiedTask[]) {
  const targetPath = getHistoryPath()
  await mkdir(path.dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8')
  await rename(tempPath, targetPath)
}

function saveHistory(items: UnifiedTask[]) {
  writeChain = writeChain.then(() => writeHistoryFile(items), () => writeHistoryFile(items))
  return writeChain
}

export async function archiveTerminalTasks(tasks: UnifiedTask[]) {
  const history = await readHistoryFile()
  const historyMap = new Map(history.map((task) => [historyKey(task), task]))

  for (const task of tasks) {
    if (isTerminalStatus(task.status)) {
      historyMap.set(historyKey(task), task)
    }
  }

  const items = Array.from(historyMap.values())
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, maxHistoryItems)

  await saveHistory(items)
  return items
}

export async function getDownloadHistory(): Promise<DownloadHistoryResult> {
  return {
    items: await readHistoryFile()
  }
}
