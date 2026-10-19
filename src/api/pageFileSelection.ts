import type { PageFileLink } from '../../shared/types'
import { filterFileLinks, groupFileExtensions } from '../../shared/fileLinkDiscovery'

export { filterFileLinks, groupFileExtensions }
export const PAGE_BATCH_LIMIT = 30

export function chooseVisibleFiles(selectedUrls: string[], visible: PageFileLink[], limit = PAGE_BATCH_LIMIT): string[] {
  const selected = new Set(selectedUrls)
  for (const item of visible) {
    if (selected.size >= limit) break
    selected.add(item.url)
  }
  return [...selected]
}

export function dropVisibleFiles(selectedUrls: string[], visible: PageFileLink[]): string[] {
  const urls = new Set(visible.map(item => item.url))
  return selectedUrls.filter(url => !urls.has(url))
}
