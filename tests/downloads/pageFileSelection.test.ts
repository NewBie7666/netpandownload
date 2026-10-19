import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chooseVisibleFiles,
  dropVisibleFiles,
  filterFileLinks,
  getFileSelectionState,
  groupFileExtensions,
  setFileTypeSelected,
  submitPageDownloadBatch,
} from '../../src/api/pageFileSelection.js'
import type { PageFileLink } from '../../shared/types.js'

const makeLink = (name: string, extension: string): PageFileLink => ({
  url: `https://example.org/files/${name}`,
  fileName: name,
  extension,
})

const pkgLinks = Array.from({ length: 33 }, (_, index) => makeLink(`package-${index + 1}.pkg`, 'pkg'))
const jsonLink = makeLink('manifest.json', 'json')
const otherLink = makeLink('download', 'other')
const links = [pkgLinks[0], pkgLinks[1], jsonLink, otherLink]

const urls = (items: PageFileLink[]): string[] => items.map(item => item.url)

test('groups scanned extensions by real counts', () => {
  assert.deepEqual(groupFileExtensions(links), [
    { extension: 'pkg', count: 2 },
    { extension: 'json', count: 1 },
    { extension: 'other', count: 1 },
  ])
})

test('selection state starts unchecked and becomes checked when every visible item is selected', () => {
  assert.deepEqual(getFileSelectionState([], pkgLinks), { checked: false, indeterminate: false })
  assert.deepEqual(getFileSelectionState([pkgLinks[0].url], pkgLinks), { checked: false, indeterminate: true })
  assert.deepEqual(getFileSelectionState(urls(pkgLinks), pkgLinks), { checked: true, indeterminate: false })
  assert.deepEqual(getFileSelectionState([], []), { checked: false, indeterminate: false })
})

test('checking a file type selects all 33 matching files and unchecking it removes all of them', () => {
  const selected = setFileTypeSelected([], pkgLinks, 'pkg', true)
  assert.deepEqual(selected, urls(pkgLinks))
  assert.deepEqual(getFileSelectionState(selected, pkgLinks), { checked: true, indeterminate: false })

  const cleared = setFileTypeSelected(selected, pkgLinks, 'pkg', false)
  assert.deepEqual(cleared, [])
  assert.deepEqual(getFileSelectionState(cleared, pkgLinks), { checked: false, indeterminate: false })
})

test('type selection preserves selected files from other types', () => {
  const selected = setFileTypeSelected([jsonLink.url, otherLink.url], links, 'pkg', true)
  assert.deepEqual(new Set(selected), new Set([jsonLink.url, otherLink.url, pkgLinks[0].url, pkgLinks[1].url]))

  const withoutPackages = setFileTypeSelected(selected, links, 'pkg', false)
  assert.deepEqual(withoutPackages, [jsonLink.url, otherLink.url])
})

test('cancelling one file produces a partial type state and checking the type again restores all files', () => {
  const selected = setFileTypeSelected([], pkgLinks.slice(0, 3), 'pkg', true)
  const partial = dropVisibleFiles(selected, [pkgLinks[1]])
  assert.deepEqual(getFileSelectionState(partial, pkgLinks.slice(0, 3)), { checked: false, indeterminate: true })

  const restored = setFileTypeSelected(partial, pkgLinks.slice(0, 3), 'pkg', true)
  assert.deepEqual(new Set(restored), new Set(urls(pkgLinks.slice(0, 3))))
  assert.deepEqual(getFileSelectionState(restored, pkgLinks.slice(0, 3)), { checked: true, indeterminate: false })
})

test('filtering changes only visible rows and leaves the selected URL set unchanged', () => {
  const selected = [pkgLinks[0].url, jsonLink.url]
  const visible = filterFileLinks(links, ['pkg'])
  assert.deepEqual(visible, [pkgLinks[0], pkgLinks[1]])
  assert.deepEqual(selected, [pkgLinks[0].url, jsonLink.url])

  const afterSelectingVisible = chooseVisibleFiles(selected, visible)
  assert.deepEqual(afterSelectingVisible, [pkgLinks[0].url, jsonLink.url, pkgLinks[1].url])
})

test('selecting visible files has no 30-file cap and deduplicates existing selections', () => {
  const selected = chooseVisibleFiles([pkgLinks[0].url, jsonLink.url], pkgLinks)
  assert.equal(selected.length, 34)
  assert.deepEqual(selected.slice(0, 2), [pkgLinks[0].url, jsonLink.url])
  assert.deepEqual(new Set(selected), new Set([jsonLink.url, ...urls(pkgLinks)]))
})

test('the normalized other type selects links with an unknown or empty extension', () => {
  const unknown = makeLink('opaque-download', '')
  const typedOther = makeLink('download-without-extension', 'other')
  const known = makeLink('archive.zip', 'zip')
  const items = [unknown, typedOther, known]

  assert.deepEqual(setFileTypeSelected([], items, 'other', true), [unknown.url, typedOther.url])
  assert.deepEqual(filterFileLinks(items, ['other']), [unknown, typedOther])
})

test('dropping visible files removes only those URLs and keeps hidden selections', () => {
  assert.deepEqual(
    dropVisibleFiles([pkgLinks[0].url, jsonLink.url], [pkgLinks[0], pkgLinks[1]]),
    [jsonLink.url],
  )
})

test('an empty batch performs no submission and reports zero counts', async () => {
  const calls: string[] = []
  const progress: number[] = []
  const result = await submitPageDownloadBatch([], async ({ url }) => calls.push(url), completed => progress.push(completed))

  assert.deepEqual(calls, [])
  assert.deepEqual(progress, [])
  assert.deepEqual(result, {
    completed: [],
    failures: [],
    remaining: [],
    attemptedCount: 0,
    unattemptedCount: 0,
  })
})

test('a 30-item batch submits every item serially and reports progress for each attempt', async () => {
  const items = pkgLinks.slice(0, 30)
  const calls: string[] = []
  const progress: number[] = []
  let active = 0
  let maxActive = 0
  const result = await submitPageDownloadBatch(items, async ({ url }) => {
    calls.push(url)
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise<void>(resolve => setImmediate(resolve))
    active -= 1
  }, completed => progress.push(completed))

  assert.deepEqual(calls, urls(items))
  assert.equal(maxActive, 1)
  assert.deepEqual(progress, Array.from({ length: 30 }, (_, index) => index + 1))
  assert.deepEqual(result, {
    completed: urls(items),
    failures: [],
    remaining: [],
    attemptedCount: 30,
    unattemptedCount: 0,
  })
})

test('a 33-item batch submits only the first 30 and leaves the last three for an explicit follow-up', async () => {
  const calls: string[] = []
  const firstProgress: number[] = []
  const first = await submitPageDownloadBatch(pkgLinks, async ({ url }) => {
    calls.push(url)
  }, completed => firstProgress.push(completed))

  assert.deepEqual(calls, urls(pkgLinks.slice(0, 30)))
  assert.deepEqual(firstProgress, Array.from({ length: 30 }, (_, index) => index + 1))
  assert.deepEqual(first.completed, urls(pkgLinks.slice(0, 30)))
  assert.deepEqual(first.failures, [])
  assert.deepEqual(first.remaining, pkgLinks.slice(30))
  assert.equal(first.attemptedCount, 30)
  assert.equal(first.unattemptedCount, 3)

  const second = await submitPageDownloadBatch(first.remaining, async ({ url }) => {
    calls.push(url)
  })
  assert.deepEqual(second.completed, urls(pkgLinks.slice(30)))
  assert.deepEqual(second.remaining, [])
  assert.equal(second.attemptedCount, 3)
  assert.equal(second.unattemptedCount, 0)
  assert.equal(calls.length, 33)
  assert.equal(new Set(calls).size, 33)
})

test('failed attempts continue, count toward progress, and remain alongside unattempted files', async () => {
  const items = pkgLinks
  const progress: number[] = []
  const calls: string[] = []
  const failedUrls = new Set([items[2].url, items[7].url])
  const result = await submitPageDownloadBatch(items, async ({ url }) => {
    calls.push(url)
    if (failedUrls.has(url)) throw new Error(`cannot add ${url}`)
  }, completed => progress.push(completed))

  assert.deepEqual(calls, urls(items.slice(0, 30)))
  assert.deepEqual(result.completed, urls(items.slice(0, 30).filter(item => !failedUrls.has(item.url))))
  assert.deepEqual(result.failures.map(failure => failure.link.url), [items[2].url, items[7].url])
  assert.deepEqual(result.failures.map(failure => failure.message), [
    `cannot add ${items[2].url}`,
    `cannot add ${items[7].url}`,
  ])
  assert.deepEqual(result.remaining, [items[2], items[7], ...items.slice(30)])
  assert.equal(result.attemptedCount, 30)
  assert.equal(result.unattemptedCount, 3)
  assert.deepEqual(progress, Array.from({ length: 30 }, (_, index) => index + 1))
  assert.ok(progress.every(value => value <= 30))
})

test('duplicate URLs are attempted once while the caller input remains unchanged', async () => {
  const first = makeLink('first.bin', 'bin')
  const duplicate = { ...first, fileName: 'duplicate-name.bin' }
  const second = makeLink('second.bin', 'bin')
  const items = [first, duplicate, second]
  const originalItems = items.slice()
  const calls: string[] = []

  const result = await submitPageDownloadBatch(items, async ({ url }) => {
    calls.push(url)
  })

  assert.deepEqual(calls, [first.url, second.url])
  assert.deepEqual(result.completed, [first.url, second.url])
  assert.deepEqual(result.remaining, [])
  assert.equal(result.attemptedCount, 2)
  assert.equal(result.unattemptedCount, 0)
  assert.deepEqual(items, originalItems)
})

test('batch submission snapshots its input before awaiting the first add operation', async () => {
  const first = { ...pkgLinks[0] }
  const second = { ...pkgLinks[1] }
  const originalSecondUrl = second.url
  const addedLater = makeLink('added-while-waiting.pkg', 'pkg')
  const items = [first, second]
  const calls: string[] = []
  let releaseFirst!: () => void
  const firstStarted = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  let resolveFirstStarted!: () => void
  const started = new Promise<void>(resolve => {
    resolveFirstStarted = resolve
  })

  const pending = submitPageDownloadBatch(items, async ({ url }) => {
    calls.push(url)
    if (url === first.url) {
      resolveFirstStarted()
      await firstStarted
    }
  })

  await started
  items.push(addedLater)
  second.url = 'https://example.org/files/mutated-second.pkg'
  releaseFirst()
  const result = await pending

  assert.deepEqual(calls, [first.url, originalSecondUrl])
  assert.deepEqual(result.completed, [first.url, originalSecondUrl])
  assert.deepEqual(result.remaining, [])
})
