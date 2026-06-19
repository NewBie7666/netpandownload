import assert from 'node:assert/strict'
import { AppError } from '../../server/http.js'
import { classifyFailure } from '../../server/providers/bilibili/stability/failureClassifier.js'
import { buildFailureInsight } from '../../server/providers/bilibili/stability/failureInsights.js'
import { diagnoseBilibiliFailure } from '../../server/providers/bilibili/diagnostics/index.js'
import { isValidCookieStructure, markCookieInvalid, getCachedCookieHealth } from '../../server/providers/bilibili/authContext/index.js'
import { presentTaskError } from '../../src/api/product/errorPresenter.js'
import type { UnifiedTask } from '../../shared/types.js'

function testFailureClassification() {
  assert.equal(classifyFailure(new Error('HTTP Error 412: Precondition Failed')).type, 'bilibili_412')
  assert.equal(classifyFailure(new Error('media blocked by upstream')).type, 'unknown_error')
  assert.equal(classifyFailure(new Error('yt-dlp timed out')).type, 'yt_dlp_timeout')
  assert.equal(classifyFailure(new AppError('media_resolution_failed', 'media failed')).type, 'media_extract_failed')
  assert.equal(classifyFailure(new Error('empty response no url')).type, 'empty_response')
}

function testCookieStates() {
  assert.equal(isValidCookieStructure('SESSDATA=abc; DedeUserID=1'), true)
  assert.equal(isValidCookieStructure('SESSDATA=abc'), false)
  assert.equal(isValidCookieStructure(''), false)
  markCookieInvalid('test expired')
  assert.equal(getCachedCookieHealth().status, 'invalid')
}

function testDiagnosisPriority() {
  const auth = buildFailureInsight(classifyFailure(new AppError('bilibili_access_restricted', 'auth failed')), 'authContext')
  const media = buildFailureInsight(classifyFailure(new AppError('media_resolution_failed', 'media failed')), 'mediaResolver')
  const diagnosis = diagnoseBilibiliFailure([media, auth])
  assert.equal(diagnosis.rootCause, 'B站登录状态不可用')
  assert.equal(diagnosis.recoverable, true)
}

function testErrorPresentation() {
  const task: UnifiedTask = {
    id: '1',
    title: 'test',
    providerId: 'bilibili',
    status: 'error',
    progress: 0,
    source: 'engine',
    createdAt: Date.now(),
    error: 'HTTP Error 412: stack trace yt-dlp resolver internal'
  }
  const presented = presentTaskError(task)
  assert.ok(presented)
  assert.equal(presented?.title, '访问受限')
  assert.doesNotMatch(`${presented?.title}${presented?.message}${presented?.actionHint}`, /yt-dlp|resolver|stack|internal/i)
}

testFailureClassification()
testCookieStates()
testDiagnosisPriority()
testErrorPresentation()

console.log('failure regression tests passed')
