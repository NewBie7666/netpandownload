import { getBehaviorProfile } from './behaviorProfile.js'
import { getTimingJitterMs } from './jitterEngine.js'

export interface AdaptiveParams {
  timingJitterMs: number
  backoffMultiplier: number
  adaptiveLevel: 0 | 1 | 2
}

export function getAdaptiveParams(seed = 'bilibili'): AdaptiveParams {
  const profile = getBehaviorProfile()
  const adaptiveLevel = profile.adaptiveLevel
  const backoffMultiplier = adaptiveLevel === 2 ? 1.5 : adaptiveLevel === 1 ? 1.2 : 1

  return {
    timingJitterMs: getTimingJitterMs(seed, adaptiveLevel),
    backoffMultiplier,
    adaptiveLevel
  }
}
