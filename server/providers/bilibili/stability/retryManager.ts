import { getAdaptiveParams } from '../adaptive/index.js'
import { classifyFailure } from './failureClassifier.js'
import { recordBilibiliFailure, recordBilibiliSuccess } from './failureLoop.js'

const backoffMs = [500, 1500, 3000]
export const maxStabilityRetries = 3

export async function waitForRetry(attempt: number) {
  const baseMs = backoffMs[Math.min(attempt, backoffMs.length - 1)]
  const { backoffMultiplier } = getAdaptiveParams('retry')
  const ms = Math.round(baseMs * backoffMultiplier)
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withBilibiliRetry<T>(operation: () => Promise<T>, maxRetries = maxStabilityRetries): Promise<T> {
  let attempt = 0
  let lastError: unknown

  for (;;) {
    try {
      const result = await operation()
      recordBilibiliSuccess()
      return result
    } catch (error) {
      lastError = error
      const failure = classifyFailure(error)
      recordBilibiliFailure(failure)
      if (!failure.retryable || attempt >= maxRetries) {
        throw error
      }
      await waitForRetry(attempt)
      attempt += 1
    }
  }

  throw lastError
}
