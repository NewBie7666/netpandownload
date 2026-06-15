import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadEngineEvent, DownloadEngineTask } from '../taskTypes.js'

interface TaskStoreFile {
  tasks?: DownloadEngineTask[]
  events?: DownloadEngineEvent[]
}

export interface StoredTaskState {
  tasks: DownloadEngineTask[]
  events: DownloadEngineEvent[]
}

let writeChain = Promise.resolve()

function getStoreDir() {
  const dataDir = String(process.env.NETPAN_DATA_DIR || '').trim()
  return path.join(dataDir || path.resolve(process.cwd(), 'data'), 'download-engine')
}

function getStorePath() {
  return path.join(getStoreDir(), 'tasks.json')
}

async function writeStoreFile(state: StoredTaskState) {
  await mkdir(getStoreDir(), { recursive: true })
  const targetPath = getStorePath()
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  const content = `${JSON.stringify(state, null, 2)}\n`
  await writeFile(tempPath, content, 'utf8')
  await rename(tempPath, targetPath)
}

function normalizeState(parsed: TaskStoreFile): StoredTaskState {
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    events: Array.isArray(parsed.events) ? parsed.events : []
  }
}

export async function loadTasks(): Promise<StoredTaskState> {
  try {
    const content = await readFile(getStorePath(), 'utf8')
    return normalizeState(JSON.parse(content) as TaskStoreFile)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { tasks: [], events: [] }
    }
    throw error
  }
}

export function saveTasks(tasks: DownloadEngineTask[], events: DownloadEngineEvent[] = []) {
  const state: StoredTaskState = {
    tasks: tasks.map((task) => ({ ...task, persisted: true })),
    events: events.map((event) => ({ ...event }))
  }
  writeChain = writeChain.then(() => writeStoreFile(state), () => writeStoreFile(state))
  return writeChain
}

export async function appendEvent(event: DownloadEngineEvent) {
  const state = await loadTasks()
  const events = [...state.events, { ...event }].slice(-200)
  return saveTasks(state.tasks, events)
}
