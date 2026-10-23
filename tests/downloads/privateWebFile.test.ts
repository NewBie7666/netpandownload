import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { resolveSafeDownloadFile } from '../../server/downloader/privateWebFile.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'netpan-file-'))
const outside = await mkdtemp(path.join(os.tmpdir(), 'netpan-outside-'))
try {
  const dir = path.join(root, 'nested')
  await mkdir(dir)
  const file = path.join(dir, 'video.mp4')
  await writeFile(file, 'TEST-CONTENT')
  const found = await resolveSafeDownloadFile(root, file)
  assert.equal(found.name, 'video.mp4')
  assert.equal(found.size, 12)
  const alien = path.join(outside, 'stolen.txt')
  await writeFile(alien, 'secret')
  await assert.rejects(resolveSafeDownloadFile(root, alien))
  await assert.rejects(resolveSafeDownloadFile(root, root))
  await assert.rejects(resolveSafeDownloadFile(root, path.join(root, 'missing')))
  const link = path.join(root, 'outside-link.txt')
  await symlink(alien, link)
  await assert.rejects(resolveSafeDownloadFile(root, link))
  const inlink = path.join(root, 'internal-link.txt')
  await symlink(file, inlink)
  assert.equal((await resolveSafeDownloadFile(root, inlink)).size, 12)
} finally {
  await rm(root, { force: true, recursive: true })
  await rm(outside, { force: true, recursive: true })
}
console.log('Private web completed-file path tests passed')
