import { getAdaptiveParams } from '../adaptive/index.js'
import { classifyFailure } from './failureClassifier.js'
import { getFailureInsight, shouldDegradeToAnonymous, type RecoveryState } from './recoveryStrategy.js'
import { recordBilibiliFailure, recordBilibiliSuccess } from './failureLoop.js'

const backoffMs = [500, 1500, 3000]
export const maxStabilityRetries = 3

export interface BilibiliRetryOptions {
  context?: 'resolve' | 'media'
  onDegrade?: () => void
  onStateChange?: (state: RecoveryState) => void
}

export async function waitForRetry(attempt: number) {
  const baseMs = backoffMs[Math.min(attempt, backoffMs.length - 1)]
  const { backoffMultiplier } = getAdaptiveParams('retry')
  const ms = Math.round(baseMs * backoffMultiplier)
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withBilibiliRetry<T>(
  operation: () => Promise<T>,
  maxRetries = maxStabilityRetries,
  options: BilibiliRetryOptions = {}
): Promise<T> {
  let attempt = 0
  let lastError: unknown
  let state: RecoveryState = 'success'

  for (;;) {
    try {
      const result = await operation()
      state = 'success'
      options.onStateChange?.(state)
      recordBilibiliSuccess()
      return result
    } catch (error) {
      lastError = error
      const failure = classifyFailure(error)
      recordBilibiliFailure(failure)
      const insight = getFailureInsight(error, options.context || 'resolve')

      if (!failure.retryable || attempt >= maxRetries) {
        options.onStateChange?.('give_up')
        throw error
      }

      if (attempt === 0) {
        state = 'retry_once'
        options.onStateChange?.(state)
        await waitForRetry(attempt)
        attempt += 1
        continue
      }

      if (state === 'retry_once' && shouldDegradeToAnonymous(insight) && options.onDegrade) {
        state = 'degrade_mode'
        options.onStateChange?.(state)
        options.onDegrade()
        await waitForRetry(attempt)
        attempt += 1
        continue
      }

      await waitForRetry(attempt)
      attempt += 1
    }
  }

  throw lastError
}
