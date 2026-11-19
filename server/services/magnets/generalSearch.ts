// Local-only adapter keeps existing download authorization behavior.
export * from '../../search-core/generalSearch.js'
import { searchGeneralMagnets as search } from '../../search-core/generalSearch.js'
import { registerAllowedDownloadUrl } from '../../downloader/downloadService.js'

export async function searchGeneralMagnets(rawQuery: unknown, rawCategory?: unknown, rawSource?: unknown) {
  const result = await search(rawQuery, rawCategory, rawSource)
  for (const item of result.items) registerAllowedDownloadUrl(item.magnet)
  return result
}
