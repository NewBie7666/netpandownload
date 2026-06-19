import type { BilibiliTraceContext } from './requestTraceContext.js'

export type TraceStage = 'resolver' | 'access' | 'auth' | 'media' | 'retry' | 'handoff'
export type TraceStageStatus = 'start' | 'success' | 'fail' | 'degraded'

export interface TraceEvent {
  stage: TraceStage
  status: TraceStageStatus
  at: number
  durationMs?: number
  errorCode?: string
}

export function createTraceEvent(
  stage: TraceStage,
  status: TraceStageStatus,
  startedAt?: number,
  errorCode?: string
): TraceEvent {
  const at = Date.now()
  return {
    stage,
    status,
    at,
    durationMs: startedAt ? Math.max(0, at - startedAt) : undefined,
    errorCode
  }
}

export async function traceStage<T>(
  context: BilibiliTraceContext | undefined,
  stage: TraceStage,
  operation: () => Promise<T>,
  record: (context: BilibiliTraceContext, event: TraceEvent) => void
) {
  if (!context) return operation()
  const startedAt = Date.now()
  record(context, createTraceEvent(stage, 'start'))
  try {
    const result = await operation()
    record(context, createTraceEvent(stage, 'success', startedAt))
    return result
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : String(error || 'unknown_error')
    record(context, createTraceEvent(stage, 'fail', startedAt, errorCode.slice(0, 120)))
    throw error
  }
}
