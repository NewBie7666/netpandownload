import assert from 'node:assert/strict'
import { createTraceContext } from '../../server/providers/bilibili/observability/requestTraceContext.js'
import { createTraceEvent } from '../../server/providers/bilibili/observability/eventTimeline.js'
import { listRecentTraces, recordTraceEvent, startTrace } from '../../server/providers/bilibili/observability/traceCollector.js'
import { recordMediaFailure, recordMediaSuccess, getMediaMetrics } from '../../server/providers/bilibili/stability/mediaMetrics.js'
import { buildFailureInsight } from '../../server/providers/bilibili/stability/failureInsights.js'
import { classifyFailure } from '../../server/providers/bilibili/stability/failureClassifier.js'
import { listRecentStructuredLogs } from '../../server/logging/structuredLogger.js'
import { cleanupReleaseLifecycle, resetForTestBatch, resetReleaseLifecycle } from '../../server/release/releaseLifecycleController.js'
import { rcWindowPolicy } from '../../server/release/freezeGuard.js'

const args = new Set(process.argv.slice(2))
const useMock = args.has('--mock') || !args.has('--real')
const total = Number(process.env.LONG_SESSION_TOTAL || 300)
const batchSize = 50

if (!useMock) {
  throw new Error('Real long session is intentionally disabled for RC freeze. Use --mock.')
}

function sampleUrl(index: number) {
  if (index % 3 === 0) return `https://www.bilibili.com/video/BV1abcdefghi?p=${index % 8}`
  if (index % 3 === 1) return `https://www.bilibili.com/bangumi/play/ep${index}`
  return `https://b23.tv/mock${index}`
}

function assertWindows() {
  const traces = listRecentTraces()
  const metrics = getMediaMetrics()
  const logs = listRecentStructuredLogs()
  assert.ok(traces.length <= rcWindowPolicy.maxTraces)
  assert.ok(traces.every((trace) => trace.events.length <= rcWindowPolicy.maxEventsPerTrace))
  assert.ok(traces.reduce((sum, trace) => sum + trace.events.length, 0) <= rcWindowPolicy.maxTotalTraceEvents)
  assert.ok(metrics.total <= rcWindowPolicy.maxMediaMetricEvents)
  assert.ok(logs.length <= rcWindowPolicy.maxLogEvents)
}

resetReleaseLifecycle()

for (let index = 0; index < total; index += 1) {
  const operation = index % 2 === 0 ? 'resolve' : 'download'
  const context = createTraceContext(sampleUrl(index), operation)
  startTrace(context)
  recordTraceEvent(context, createTraceEvent('resolver', 'start'))
  recordTraceEvent(context, createTraceEvent('resolver', 'success'))

  if (index % 5 === 0) {
    recordTraceEvent(context, createTraceEvent('retry', 'start'))
    recordTraceEvent(context, createTraceEvent('media', 'fail', undefined, 'media_resolution_failed'))
    recordMediaFailure(buildFailureInsight(classifyFailure(new Error('HTTP Error 412: Precondition Failed')), 'mediaResolver'))
  } else {
    recordTraceEvent(context, createTraceEvent('media', 'success'))
    recordTraceEvent(context, createTraceEvent('handoff', 'success'))
    recordMediaSuccess()
  }

  if ((index + 1) % batchSize === 0) {
    cleanupReleaseLifecycle()
    assertWindows()
    resetForTestBatch()
  }
}

cleanupReleaseLifecycle()
assertWindows()
resetReleaseLifecycle()

console.log('long session stability tests passed')
