import type { DecisionCore, PlatformFacts } from './types'

export function applyCapabilityRules(facts: PlatformFacts): DecisionCore {
  if (!facts.hasFiles) {
    return {
      platform: facts.platform,
      resourceType: facts.resourceType,
      status: 'unknown',
      canDownload: false
    }
  }

  if (facts.hasBlocked) {
    return {
      platform: facts.platform,
      resourceType: facts.resourceType,
      status: 'blocked',
      canDownload: false
    }
  }

  if (facts.platform === 'bilibili') {
    return {
      platform: facts.platform,
      resourceType: facts.resourceType,
      status: facts.hasRestricted ? 'blocked' : 'limited',
      canDownload: !facts.hasRestricted
    }
  }

  if (facts.platform === 'quark') {
    return {
      platform: facts.platform,
      resourceType: facts.resourceType,
      status: facts.hasRestricted ? 'limited' : 'ok',
      canDownload: true
    }
  }

  return {
    platform: facts.platform,
    resourceType: facts.resourceType,
    status: 'unknown',
    canDownload: false
  }
}
