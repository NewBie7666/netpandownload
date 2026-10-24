import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { aria2SessionArgs, aria2SessionPath, ensureAria2SessionFile } from '../../electron/aria2Session.js'
import { requireTaskAction } from '../../server/downloader/taskActionPolicy.js'

test('pause permits active and waiting; is idempotent', () => {
  assert.equal(requireTaskAction('pause', 'active'), true)
  assert.equal(requireTaskAction('pause', 'waiting'), true)
  assert.equal(requireTaskAction('pause', 'paused'), false)
})
test('resume permits paused; is idempotent', () => {
  assert.equal(requireTaskAction('resume', 'paused'), true)
  assert.equal(requireTaskAction('resume', 'active'), false)
  assert.equal(requireTaskAction('resume', 'waiting'), false)
})
test('terminal tasks cannot be resumed or paused', () => {
  for (const status of ['complete','error','removed'] as const) {
    assert.throws(() => requireTaskAction('pause',status))
    assert.throws(() => requireTaskAction('resume',status))
  }
})
test('session file survives initialization and CLI switches restore session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'netpan-aria2-'))
  try {
    const p = aria2SessionPath(dir)
    await ensureAria2SessionFile(p)
    assert.equal(await readFile(p,'utf8'),'')
    await writeFile(p, 'https://example.org/file.bin\n')
    await ensureAria2SessionFile(p)
    assert.equal(await readFile(p,'utf8'),'https://example.org/file.bin\n')
    const args = aria2SessionArgs(p)
    assert.ok(args.includes('--input-file=' + p))
    assert.ok(args.includes('--save-session=' + p))
    assert.ok(args.some(v=>v.startsWith('--save-session-interval=')))
  } finally {
    await rm(dir,{recursive:true,force:true})
  }
})
