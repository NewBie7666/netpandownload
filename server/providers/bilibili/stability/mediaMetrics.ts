import type { FailureInsight } from './failureInsights.js'
import { rcWindowPolicy } from '../../../release/freezeGuard.js'

interface MediaMetricEvent {
  ok: boolean
  type?: FailureInsight['type']
  layer?: FailureInsight['layer']
  timestamp: number
}

const events: MediaMetricEvent[] = []

export function trimMediaMetrics(now = Date.now()) {
  while (events.length && (
    events.length > rcWindowPolicy.maxMediaMetricEvents ||
    now - events[0].timestamp > rcWindowPolicy.mediaMetricWindowMs
  )) {
    events.shift()
  }
}

export function recordMediaSuccess() {
  events.push({ ok: true, timestamp: Date.now() })
  trimMediaMetrics()
}

export function recordMediaFailure(insight: FailureInsight) {
  events.push({
    ok: false,
    type: insight.type,
    layer: insight.layer,
    timestamp: Date.now()
  })
  trimMediaMetrics()
}

function countBy<T extends string>(values: Array<T | undefined>) {
  const result: Partial<Record<T, number>> = {}
  for (const value of values) {
    if (!value) continue
    result[value] = (result[value] || 0) + 1
  }
  return result
}

export function getMediaMetrics() {
  trimMediaMetrics()
  const total = events.length
  const success = events.filter((event) => event.ok).length
  const failures = events.filter((event) => !event.ok)

  return {
    total,
    successCount: success,
    failureCount: failures.length,
    successRate: total ? success / total : 1,
    failureTypes: countBy(failures.map((event) => event.type)),
    failureLayers: countBy(failures.map((event) => event.layer))
  }
}

export function resetMediaMetrics() {
  events.splice(0, events.length)
}
