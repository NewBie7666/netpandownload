import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getAria2TaskAction } from '../../src/views/download-center/components/taskActions.js'
import { normalizeProductTask } from '../../src/api/product.js'
import type { UnifiedTask } from '../../shared/types.js'

const aria2Task = {
  id: '5698ac5a7797e823',
  gid: '5698ac5a7797e823',
  title: '5698ac5a7797e823',
  providerId: 'unknown',
  status: 'paused',
  source: 'aria2',
  createdAt: Date.now()
} satisfies UnifiedTask

test('restarted paused aria2 task retains GID and exposes resume', () => {
  const ui = normalizeProductTask(aria2Task)
  assert.equal(ui.gid, '5698ac5a7797e823')
  assert.equal(ui.source, 'aria2')
  assert.equal(ui.status, 'paused')
  assert.equal(getAria2TaskAction(ui), 'resume')
})

test('active and queued aria2 tasks expose pause', () => {
  assert.equal(getAria2TaskAction(normalizeProductTask({ ...aria2Task, status: 'running' })), 'pause')
  assert.equal(getAria2TaskAction(normalizeProductTask({ ...aria2Task, status: 'queued' })), 'pause')
  assert.equal(getAria2TaskAction(normalizeProductTask({ ...aria2Task, status: 'pending' })), 'pause')
})

test('done or failed tasks cannot be resumed', () => {
  assert.equal(getAria2TaskAction(normalizeProductTask({ ...aria2Task, status: 'done' })), null)
  assert.equal(getAria2TaskAction(normalizeProductTask({ ...aria2Task, status: 'error' })), null)
})

test('never send provider engine task IDs to aria2 endpoint', () => {
  assert.equal(getAria2TaskAction(normalizeProductTask({ ...aria2Task, source: 'engine' })), null)
  assert.equal(getAria2TaskAction(normalizeProductTask({ ...aria2Task, gid: undefined })), null)
})
