export { classifyFailure, type ClassifiedFailure, type BilibiliFailureType } from './failureClassifier.js'
export { withBilibiliRetry, waitForRetry, maxStabilityRetries } from './retryManager.js'
export { throttleBilibiliRequest } from './throttleManager.js'
export { toBilibiliFailSafeError } from './recoveryStrategy.js'
export { recordBilibiliFailure, recordBilibiliSuccess } from './failureLoop.js'

export function initializeStabilityLayer() {
  return {
    ready: true
  }
}
