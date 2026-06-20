import type { DecisionCore, PlatformFacts } from './types'

export function generateReasonCodes(core: DecisionCore, facts: PlatformFacts): string[] {
  if (core.status === 'blocked') {
    return facts.platform === 'bilibili'
      ? ['restricted_resource', 'desktop_required']
      : ['blocked_resource']
  }

  if (core.platform === 'bilibili') {
    return ['temporary_media', 'desktop_required', 'login_may_required']
  }

  if (core.platform === 'quark') {
    return [
      facts.hasAvailable ? 'available_file' : 'metadata_only',
      'temporary_link_possible',
      'local_downloader_recommended'
    ]
  }

  return ['unsupported']
}
