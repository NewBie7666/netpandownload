import assert from 'node:assert/strict'
import { providerOk, toInternalExecutionContract } from '../../server/providers/providerResponse.js'
import { createTraceContext } from '../../server/providers/bilibili/observability/requestTraceContext.js'
import { createTraceEvent } from '../../server/providers/bilibili/observability/eventTimeline.js'
import { listRecentTraces, recordTraceEvent, resetTraceWindow, startTrace } from '../../server/providers/bilibili/observability/traceCollector.js'
import { structuredLogger, listRecentStructuredLogs, resetStructuredLogWindow } from '../../server/logging/structuredLogger.js'
import { normalizeProductTask } from '../../src/api/product.js'
import { presentTaskError } from '../../src/api/product/errorPresenter.js'
import type { DownloadResult, ShareResult, UnifiedTask } from '../../shared/types.js'

function testProviderWrapperContract() {
  const share: ShareResult = { shareId: 's', stoken: 't', path: [], files: [] }
  const contract = toInternalExecutionContract(providerOk('bilibili', share, 'real'), 'resolve')
  assert.equal(contract.ok, true)
  assert.equal(contract.providerId, 'bilibili')
  assert.equal(contract.operation, 'resolve')
  assert.ok(contract.meta.runtime.traceId)
  assert.equal(contract.meta.runtime.executable, true)
}

function testDownloadResultContract() {
  const download: DownloadResult = {
    fid: 'f',
    name: 'video.mp4',
    downloadUrl: 'https://example.test/video.mp4',
    source: 'direct',
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    cached: false
  }
  assert.equal(typeof download.fid, 'string')
  assert.equal(typeof download.name, 'string')
  assert.equal(download.source, 'direct')
  assert.equal(download.cached, false)
}

function testTraceAndLogContract() {
  resetTraceWindow()
  resetStructuredLogWindow()
  const context = createTraceContext('https://www.bilibili.com/video/BV1abcdefghi', 'download')
  assert.throws(() => {
    ;(context as { traceId: string }).traceId = 'mutated'
  })
  startTrace(context)
  recordTraceEvent(context, createTraceEvent('resolver', 'start'))
  assert.equal(listRecentTraces()[0]?.traceId, context.traceId)

  structuredLogger.info('release-test', 'schema check', { token: 'secret' }, context.traceId)
  const log = listRecentStructuredLogs()[0]
  assert.deepEqual(Object.keys(log).sort(), ['layer', 'level', 'message', 'meta', 'timestamp', 'traceId'])
  assert.equal(log.meta?.token, '[redacted]')
}

function testUiContract() {
  const task: UnifiedTask = {
    id: 'task-1',
    title: 'Video',
    providerId: 'bilibili',
    status: 'running',
    progress: 150,
    source: 'engine',
    createdAt: Date.now()
  }
  const uiTask = normalizeProductTask(task)
  assert.equal(uiTask.status, 'active')
  assert.equal(uiTask.progress, 100)
  assert.deepEqual(
    Object.keys(uiTask).filter((key) => uiTask[key as keyof typeof uiTask] !== undefined).sort(),
    ['createdAt', 'id', 'progress', 'providerId', 'status', 'title'].sort()
  )

  const presented = presentTaskError({ ...task, status: 'error', error: 'timeout' })
  assert.ok(presented)
  assert.deepEqual(Object.keys(presented!).sort(), ['actionHint', 'level', 'message', 'recoverable', 'title'].sort())
  assert.equal(typeof presented!.recoverable, 'boolean')
}

testProviderWrapperContract()
testDownloadResultContract()
testTraceAndLogContract()
testUiContract()

console.log('contract regression tests passed')
