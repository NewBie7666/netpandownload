export { classifyFailure, type ClassifiedFailure, type BilibiliFailureType } from './failureClassifier.js'
export { withBilibiliRetry, waitForRetry, maxStabilityRetries } from './retryManager.js'
export { throttleBilibiliRequest } from './throttleManager.js'
export { getFailureInsight, shouldDegradeToAnonymous, toBilibiliFailSafeError } from './recoveryStrategy.js'
export { recordBilibiliFailure, recordBilibiliSuccess } from './failureLoop.js'
export {
  BilibiliLayeredError,
  buildFailureInsight,
  getFailureLayer,
  getInternalFailureLayer,
  unwrapFailureCause,
  withFailureLayer,
  type FailureInsight,
  type FailureInsightLayer,
  type FailureInsightType,
  type InternalFailureLayer
} from './failureInsights.js'
export { getMediaMetrics, recordMediaFailure, recordMediaSuccess } from './mediaMetrics.js'

export function initializeStabilityLayer() {
  return {
    ready: true
  }
}
