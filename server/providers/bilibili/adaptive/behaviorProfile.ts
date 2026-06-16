import type { BilibiliFailureType } from '../stability/failureClassifier.js'

export interface BehaviorProfile {
  successCount: number
  failureCount: number
  failureTypeHistory: BilibiliFailureType[]
  adaptiveLevel: 0 | 1 | 2
  lastUpdatedAt: number
}

const maxHistory = 20

const profile: BehaviorProfile = {
  successCount: 0,
  failureCount: 0,
  failureTypeHistory: [],
  adaptiveLevel: 0,
  lastUpdatedAt: Date.now()
}

export function getBehaviorProfile(): BehaviorProfile {
  return { ...profile, failureTypeHistory: [...profile.failureTypeHistory] }
}

export function recordAdaptiveSuccess() {
  profile.successCount += 1
  profile.lastUpdatedAt = Date.now()
  if (profile.successCount > 3 && profile.adaptiveLevel > 0) {
    profile.adaptiveLevel = Math.max(0, profile.adaptiveLevel - 1) as 0 | 1 | 2
    profile.successCount = 0
  }
}

export function recordAdaptiveFailure(type: BilibiliFailureType) {
  profile.failureCount += 1
  profile.successCount = 0
  profile.failureTypeHistory.push(type)
  if (profile.failureTypeHistory.length > maxHistory) {
    profile.failureTypeHistory.splice(0, profile.failureTypeHistory.length - maxHistory)
  }

  if (type === 'bilibili_412' || type === 'rate_limited') {
    profile.adaptiveLevel = 2
  } else if (type === 'yt_dlp_timeout' || type === 'media_extract_failed' || type === 'network_error') {
    profile.adaptiveLevel = Math.max(profile.adaptiveLevel, 1) as 0 | 1 | 2
  }
  profile.lastUpdatedAt = Date.now()
}
