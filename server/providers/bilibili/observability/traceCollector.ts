import type { TraceEvent } from './eventTimeline.js'
import type { BilibiliTraceContext } from './requestTraceContext.js'
import { rcWindowPolicy } from '../../../release/freezeGuard.js'

export interface BilibiliTrace {
  traceId: string
  normalizedUrl: string
  operation: string
  startedAt: number
  lastUpdatedAt: number
  events: TraceEvent[]
}

const traces = new Map<string, BilibiliTrace>()

function totalEventCount() {
  let count = 0
  for (const trace of traces.values()) count += trace.events.length
  return count
}

export function trimTraceWindow(now = Date.now()) {
  for (const [traceId, trace] of traces.entries()) {
    if (now - trace.lastUpdatedAt > rcWindowPolicy.traceTtlMs) {
      traces.delete(traceId)
    }
  }

  while (traces.size > rcWindowPolicy.maxTraces || totalEventCount() > rcWindowPolicy.maxTotalTraceEvents) {
    const oldest = Array.from(traces.values()).sort((left, right) => left.lastUpdatedAt - right.lastUpdatedAt)[0]
    if (!oldest) return
    traces.delete(oldest.traceId)
  }
}

export function startTrace(context: BilibiliTraceContext) {
  const existing = traces.get(context.traceId)
  if (existing) return existing

  const trace: BilibiliTrace = {
    traceId: context.traceId,
    normalizedUrl: context.normalizedUrl,
    operation: context.operation,
    startedAt: context.startedAt,
    lastUpdatedAt: context.startedAt,
    events: []
  }
  traces.set(context.traceId, trace)
  trimTraceWindow()
  return trace
}

export function recordTraceEvent(context: BilibiliTraceContext | undefined, event: TraceEvent) {
  if (!context) return
  const trace = startTrace(context)
  trace.events.push(event)
  if (trace.events.length > rcWindowPolicy.maxEventsPerTrace) {
    trace.events.splice(0, trace.events.length - rcWindowPolicy.maxEventsPerTrace)
  }
  trace.lastUpdatedAt = event.at
  trimTraceWindow(event.at)
}

export function getTrace(traceId: string | undefined) {
  if (!traceId) return undefined
  trimTraceWindow()
  const trace = traces.get(traceId)
  return trace ? { ...trace, events: trace.events.map((event) => ({ ...event })) } : undefined
}

export function listRecentTraces() {
  trimTraceWindow()
  return Array.from(traces.values())
    .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt)
    .map((trace) => ({ ...trace, events: trace.events.map((event) => ({ ...event })) }))
}

export function resetTraceWindow() {
  traces.clear()
}
