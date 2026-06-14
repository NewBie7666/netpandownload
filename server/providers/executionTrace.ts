import { randomUUID } from 'node:crypto'
import type {
  ProviderCapabilities,
  ProviderErrorCode,
  ProviderId,
  ProviderSource,
  ProviderStatus
} from './types.js'

export type ProviderOperation = 'resolve' | 'list' | 'download' | 'debug'

export interface ExecutionTraceInput {
  providerId: ProviderId
  operation: ProviderOperation
  status: ProviderStatus
  errorCode?: ProviderErrorCode
  source?: ProviderSource
  executable: boolean
  startedAt: number
  capabilitiesSnapshot?: ProviderCapabilities
}

export interface ExecutionTrace {
  traceId: string
  providerId: ProviderId
  operation: ProviderOperation
  status: ProviderStatus
  errorCode?: ProviderErrorCode
  source?: ProviderSource
  executable: boolean
  durationMs: number
  capabilitiesSnapshot?: ProviderCapabilities
}

let lastTrace: ExecutionTrace | undefined

export function recordExecutionTrace(input: ExecutionTraceInput) {
  const trace: ExecutionTrace = {
    traceId: randomUUID(),
    providerId: input.providerId,
    operation: input.operation,
    status: input.status,
    errorCode: input.errorCode,
    source: input.source,
    executable: input.executable,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    capabilitiesSnapshot: input.capabilitiesSnapshot
  }
  lastTrace = trace
  return trace
}

export function getLastExecutionTrace() {
  return lastTrace
}
