import type { DecisionCore, RiskLevel } from './types'

export function computeRisk(core: DecisionCore, reasonCodes: string[]): RiskLevel {
  let score = 0

  if (core.status === 'blocked') score += 50
  if (core.status === 'limited') score += 20
  if (reasonCodes.includes('temporary_media')) score += 15
  if (reasonCodes.includes('login_may_required')) score += 10
  if (reasonCodes.includes('restricted_resource')) score += 25
  if (core.platform === 'quark') score -= 10

  if (score >= 60) return 'high'
  if (score >= 25) return 'medium'
  return 'low'
}
