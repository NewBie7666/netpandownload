import type { DecisionCore } from './types'

export function computeConfidence(core: DecisionCore, reasonCodes: string[]): number {
  let score = 50

  if (core.platform === 'quark') score = 90
  if (core.platform === 'bilibili') score = 70
  if (core.platform === 'youtube') score = 75
  if (core.platform === 'douyin') score = 40
  if (core.platform === 'zhihu' || core.platform === 'instagram') score = 35

  if (core.status === 'blocked') score -= 35
  if (core.status === 'unknown') score -= 30
  if (reasonCodes.includes('restricted_resource')) score -= 20
  if (reasonCodes.includes('temporary_media')) score -= 0
  if (reasonCodes.includes('login_may_required')) score -= 5
  if (reasonCodes.includes('available_file')) score += 5

  return Math.max(0, Math.min(100, Math.round(score)))
}
