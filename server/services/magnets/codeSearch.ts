// Local-only adapter keeps existing download authorization behavior.
export * from '../../search-core/codeSearch.js'
import { searchByCode as search } from '../../search-core/codeSearch.js'
import { registerAllowedDownloadUrl } from '../../downloader/downloadService.js'

export async function searchByCode(rawCode: unknown) {
  const result = await search(rawCode)
  for (const item of result.items) registerAllowedDownloadUrl(item.magnet)
  return result
}
