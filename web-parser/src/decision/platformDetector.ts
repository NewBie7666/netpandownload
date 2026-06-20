import type { WebParseResult } from '../../server/types'
import type { PlatformFacts, ResourceType } from './types'

function detectResourceType(result: WebParseResult): ResourceType {
  if (result.providerId === 'bilibili') return result.files.length > 1 ? 'playlist' : 'video'
  if (result.providerId === 'quark') return result.files.some((file) => file.type === 'folder') ? 'folder' : 'file'
  return 'unknown'
}

export function detectPlatformFacts(result: WebParseResult): PlatformFacts {
  const statuses = result.files.map((file) => file.status)

  return {
    platform: result.providerId,
    resourceType: detectResourceType(result),
    hasAvailable: statuses.includes('available'),
    hasTemporary: statuses.includes('temporary'),
    hasRestricted: statuses.includes('restricted'),
    hasBlocked: statuses.includes('blocked'),
    hasFiles: result.files.length > 0
  }
}
