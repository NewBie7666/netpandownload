import { resetTraceWindow, trimTraceWindow } from '../providers/bilibili/observability/traceCollector.js'
import { resetMediaMetrics, trimMediaMetrics } from '../providers/bilibili/stability/mediaMetrics.js'
import { resetStructuredLogWindow, trimStructuredLogWindow } from '../logging/structuredLogger.js'

export function cleanupReleaseLifecycle(now = Date.now()) {
  trimTraceWindow(now)
  trimMediaMetrics(now)
  trimStructuredLogWindow()
}

export function resetReleaseLifecycle() {
  resetTraceWindow()
  resetMediaMetrics()
  resetStructuredLogWindow()
}

export function resetForTestBatch() {
  resetReleaseLifecycle()
}
