import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { test } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import type { UnifiedTask } from '../../shared/types.js'

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'netpan-history-'))
const previousDataDir = process.env.NETPAN_DATA_DIR
process.env.NETPAN_DATA_DIR = dataDir
const { archiveTerminalTasks, getDownloadHistory } = await import('../../server/product/historyService.js')

function task(index: number): UnifiedTask {
  return {
    id: `history-${index}`,
    gid: `history-${index}`,
    title: `history-${index}.bin`,
    providerId: 'unknown',
    status: 'done',
    source: 'aria2',
    createdAt: index
  }
}

test.after(async () => {
  if (previousDataDir === undefined) delete process.env.NETPAN_DATA_DIR
  else process.env.NETPAN_DATA_DIR = previousDataDir
  await rm(dataDir, { recursive: true, force: true })
})

test('serializes concurrent archive/read transactions without lost history or temp files', async () => {
  const tasks = Array.from({ length: 64 }, (_, index) => task(index))
  const operations = tasks.flatMap((item) => [
    archiveTerminalTasks([item]),
    getDownloadHistory()
  ])

  const results = await Promise.all(operations)
  assert.equal(results.length, tasks.length * 2)

  const history = await getDownloadHistory()
  assert.equal(history.items.length, tasks.length)
  assert.deepEqual(
    new Set(history.items.map((item) => item.id)),
    new Set(tasks.map((item) => item.id))
  )
  assert.deepEqual(await readdir(dataDir), ['download-history.json'])
})

test('keeps the 500-item history cap after serialized writes', async () => {
  await Promise.all(
    Array.from({ length: 520 }, (_, index) => archiveTerminalTasks([task(1000 + index)]))
  )

  const history = await getDownloadHistory()
  assert.equal(history.items.length, 500)
  assert.equal(history.items[0]?.id, 'history-1519')
  assert.equal(history.items.at(-1)?.id, 'history-1020')
})
