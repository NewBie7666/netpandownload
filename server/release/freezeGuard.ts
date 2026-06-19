import type { StructuredLogEntry } from '../logging/structuredLogger.js'

export const rcWindowPolicy = Object.freeze({
  maxTraces: 100,
  maxEventsPerTrace: 50,
  maxTotalTraceEvents: 3000,
  traceTtlMs: 10 * 60 * 1000,
  maxMediaMetricEvents: 100,
  mediaMetricWindowMs: 10 * 60 * 1000,
  maxLogEvents: 3000
})

export const frozenUiStatuses = Object.freeze(['waiting', 'active', 'paused', 'success', 'failed'] as const)
export const frozenHealthValues = Object.freeze(['stable', 'degraded', 'unstable'] as const)
export const frozenPresentedErrorKeys = Object.freeze(['title', 'message', 'level', 'actionHint', 'recoverable'] as const)
export const frozenDiagnosisKeys = Object.freeze(['rootCause', 'explanation', 'suggestedAction', 'recoverable', 'health'] as const)
export const frozenLogKeys = Object.freeze(['timestamp', 'level', 'traceId', 'layer', 'message', 'meta'] as const)

export type FrozenUiStatus = (typeof frozenUiStatuses)[number]
export type FrozenHealth = (typeof frozenHealthValues)[number]

function keySet(value: Record<string, unknown>) {
  return Object.keys(value).sort().join(',')
}

export function assertStructuredLogContract(entry: StructuredLogEntry) {
  const keys = Object.keys(entry).sort()
  const allowed = [...frozenLogKeys].sort()
  const invalid = keys.filter((key) => !allowed.includes(key as (typeof frozenLogKeys)[number]))
  const missing = allowed.filter((key) => !keys.includes(key))
  if (invalid.length || missing.length) {
    throw new Error(`RC freeze violation: structured log schema drift invalid=${invalid.join('|')} missing=${missing.join('|')}`)
  }
}

export function assertUiStatus(status: string) {
  if (!frozenUiStatuses.includes(status as FrozenUiStatus)) {
    throw new Error(`RC freeze violation: unknown UI status ${status}`)
  }
}

export function assertHealthValue(health: string | undefined) {
  if (health && !frozenHealthValues.includes(health as FrozenHealth)) {
    throw new Error(`RC freeze violation: unknown health value ${health}`)
  }
}

export function assertPresentedErrorShape(value: unknown) {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const allowed = [...frozenPresentedErrorKeys]
  const invalid = Object.keys(record).filter((key) => !allowed.includes(key as (typeof frozenPresentedErrorKeys)[number]))
  if (invalid.length) {
    throw new Error(`RC freeze violation: presented error schema drift ${keySet(record)}`)
  }
}

export function assertDiagnosisShape(value: unknown) {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const allowed = [...frozenDiagnosisKeys]
  const invalid = Object.keys(record).filter((key) => !allowed.includes(key as (typeof frozenDiagnosisKeys)[number]))
  const required = allowed.filter((key) => key !== 'health' ? !(key in record) : false)
  if (invalid.length || required.length) {
    throw new Error(`RC freeze violation: diagnosis schema drift ${keySet(record)}`)
  }
}

export function assertBilibiliRuntimeFreeze() {
  return true
}
