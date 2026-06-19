import { buildAuthContext } from '../providers/bilibili/authContext/index.js'
import { createTraceEvent } from '../providers/bilibili/observability/eventTimeline.js'
import { createTraceContext } from '../providers/bilibili/observability/requestTraceContext.js'
import { getTrace, recordTraceEvent, startTrace } from '../providers/bilibili/observability/traceCollector.js'
import { structuredLogger } from '../logging/structuredLogger.js'

export type RuntimeHealthStatus = 'READY' | 'DEGRADED' | 'FAILED'

export interface RuntimeHealthCheckResult {
  status: RuntimeHealthStatus
  checks: {
    authContext: RuntimeHealthStatus
    mediaResolver: RuntimeHealthStatus
    structuredLogger: RuntimeHealthStatus
    traceSystem: RuntimeHealthStatus
  }
  message: string
}

function worstStatus(statuses: RuntimeHealthStatus[]): RuntimeHealthStatus {
  if (statuses.includes('FAILED')) return 'FAILED'
  if (statuses.includes('DEGRADED')) return 'DEGRADED'
  return 'READY'
}

async function checkAuthContext(): Promise<RuntimeHealthStatus> {
  const context = buildAuthContext('https://www.bilibili.com/video/BV1abcdefghi')
  return context.userAgent && context.refererChain.length && context.episodeSessionId ? 'READY' : 'FAILED'
}

async function checkMediaResolver(): Promise<RuntimeHealthStatus> {
  const module = await import('../providers/bilibili/media/mediaResolver.js')
  return typeof module.resolveMedia === 'function' ? 'READY' : 'FAILED'
}

async function checkStructuredLogger(): Promise<RuntimeHealthStatus> {
  structuredLogger.debug('runtime-health', 'structured logger dry run')
  return 'READY'
}

async function checkTraceSystem(): Promise<RuntimeHealthStatus> {
  const context = createTraceContext('https://www.bilibili.com/video/BV1abcdefghi', 'resolve')
  startTrace(context)
  recordTraceEvent(context, createTraceEvent('resolver', 'success'))
  const trace = getTrace(context.traceId)
  return trace?.events.length ? 'READY' : 'FAILED'
}

async function safeCheck(name: keyof RuntimeHealthCheckResult['checks'], check: () => Promise<RuntimeHealthStatus>) {
  try {
    return await check()
  } catch (error) {
    structuredLogger.warn('runtime-health', `${name} check failed`, {
      error: error instanceof Error ? error.message : String(error)
    })
    return 'FAILED'
  }
}

export async function runRuntimeHealthCheck(): Promise<RuntimeHealthCheckResult> {
  const checks = {
    authContext: await safeCheck('authContext', checkAuthContext),
    mediaResolver: await safeCheck('mediaResolver', checkMediaResolver),
    structuredLogger: await safeCheck('structuredLogger', checkStructuredLogger),
    traceSystem: await safeCheck('traceSystem', checkTraceSystem)
  }
  const status = worstStatus(Object.values(checks))
  const result: RuntimeHealthCheckResult = {
    status,
    checks,
    message: status === 'READY'
      ? 'Runtime health check passed'
      : status === 'DEGRADED'
        ? 'Runtime health check passed with degraded components'
        : 'Runtime health check failed'
  }
  structuredLogger[status === 'FAILED' ? 'error' : status === 'DEGRADED' ? 'warn' : 'info'](
    'runtime-health',
    result.message,
    { checks }
  )
  return result
}
