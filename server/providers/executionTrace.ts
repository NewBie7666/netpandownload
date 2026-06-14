import { randomUUID } from 'node:crypto'
import type {
  ProviderErrorCode,
  ProviderId,
  ProviderResultKind,
  ProviderSource
} from './types.js'

export type ProviderOperation = 'resolve' | 'list' | 'download' | 'debug'

export interface ExecutionTraceInput {
  providerId: ProviderId
  operation: ProviderOperation
  kind: ProviderResultKind
  errorCode?: ProviderErrorCode
  source?: ProviderSource
  executable: boolean
  startedAt: number
}

export interface ExecutionTrace {
  traceId: string
  providerId: ProviderId
  operation: ProviderOperation
  kind: ProviderResultKind
  status: 'ok' | 'error'
  errorCode?: ProviderErrorCode
  source?: ProviderSource
  executable: boolean
  durationMs: number
}

let lastTrace: ExecutionTrace | undefined

export function recordExecutionTrace(input: ExecutionTraceInput) {
  const trace: ExecutionTrace = {
    traceId: randomUUID(),
    providerId: input.providerId,
    operation: input.operation,
    kind: input.kind,
    status: input.kind === 'success' ? 'ok' : 'error',
    errorCode: input.errorCode,
    source: input.source,
    executable: input.executable,
    durationMs: Math.max(0, Date.now() - input.startedAt)
  }
  lastTrace = trace
  return trace
}

export function getLastExecutionTrace() {
  return lastTrace
}
