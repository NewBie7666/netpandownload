import { recordAdaptiveFailure, recordAdaptiveSuccess } from '../adaptive/index.js'
import type { ClassifiedFailure } from './failureClassifier.js'

export function recordBilibiliFailure(failure: ClassifiedFailure) {
  recordAdaptiveFailure(failure.type)
}

export function recordBilibiliSuccess() {
  recordAdaptiveSuccess()
}
