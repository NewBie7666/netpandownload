import type { PageFileLink } from '../../shared/types'
import { filterFileLinks, groupFileExtensions } from '../../shared/fileLinkDiscovery'

export { filterFileLinks, groupFileExtensions }
export const PAGE_BATCH_LIMIT = 30

export function chooseVisibleFiles(selectedUrls: string[], visible: PageFileLink[]): string[] {
  const selected = new Set(selectedUrls)
  for (const item of visible) {
    selected.add(item.url)
  }
  return [...selected]
}

export function getFileSelectionState(selectedUrls: string[], items: PageFileLink[]): { checked: boolean; indeterminate: boolean } {
  const selected = new Set(selectedUrls)
  const count = items.filter(item => selected.has(item.url)).length
  return {
    checked: items.length > 0 && count === items.length,
    indeterminate: count > 0 && count < items.length
  }
}

export function setFileTypeSelected(selectedUrls: string[], items: PageFileLink[], extension: string, checked: boolean): string[] {
  const matching = filterFileLinks(items, [extension])
  return checked ? chooseVisibleFiles(selectedUrls, matching) : dropVisibleFiles(selectedUrls, matching)
}

// Selection can exceed 30; only an explicit submit sends this bounded snapshot.
export async function submitPageDownloadBatch(
  items: PageFileLink[],
  add: (input: { url: string }) => Promise<unknown>,
  onProgress?: (completed: number) => void
): Promise<{
  completed: string[]
  failures: { link: PageFileLink; message: string }[]
  remaining: PageFileLink[]
  attemptedCount: number
  unattemptedCount: number
}> {
  const unique = [...new Map(items.map(item => [item.url, { ...item }])).values()]
  const batch = unique.slice(0, PAGE_BATCH_LIMIT)
  const completed: string[] = []
  const failures: { link: PageFileLink; message: string }[] = []
  for (const [index, link] of batch.entries()) {
    try {
      await add({ url: link.url })
      completed.push(link.url)
    } catch (error) {
      failures.push({ link, message: error instanceof Error ? error.message : '无法添加' })
    }
    onProgress?.(index + 1)
  }
  const succeeded = new Set(completed)
  return {
    completed,
    failures,
    remaining: unique.filter(item => !succeeded.has(item.url)),
    attemptedCount: batch.length,
    unattemptedCount: unique.length - batch.length
  }
}

export function dropVisibleFiles(selectedUrls: string[], visible: PageFileLink[]): string[] {
  const urls = new Set(visible.map(item => item.url))
  return selectedUrls.filter(url => !urls.has(url))
}
