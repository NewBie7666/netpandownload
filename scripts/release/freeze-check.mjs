import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function read(path) {
  return readFileSync(join(root, path), 'utf8')
}

function assertContains(path, text, label = text) {
  if (!read(path).includes(text)) {
    throw new Error(`[freeze-check] ${path} missing ${label}`)
  }
}

function assertNotContains(path, pattern, label = String(pattern)) {
  const content = read(path)
  if (pattern instanceof RegExp ? pattern.test(content) : content.includes(pattern)) {
    throw new Error(`[freeze-check] ${path} contains forbidden ${label}`)
  }
}

const uiStateMapper = read('src/api/product/taskStateMapper.ts')
for (const status of ['waiting', 'active', 'paused', 'success', 'failed']) {
  if (!uiStateMapper.includes(status)) throw new Error(`[freeze-check] missing UI status ${status}`)
}

assertContains('server/logging/structuredLogger.ts', 'timestamp')
assertContains('server/logging/structuredLogger.ts', 'level')
assertContains('server/logging/structuredLogger.ts', 'traceId')
assertContains('server/logging/structuredLogger.ts', 'layer')
assertContains('server/logging/structuredLogger.ts', 'message')
assertContains('server/logging/structuredLogger.ts', 'meta')

assertContains('server/release/freezeGuard.ts', 'maxTraces: 100')
assertContains('server/release/freezeGuard.ts', 'maxEventsPerTrace: 50')
assertContains('server/release/freezeGuard.ts', 'maxTotalTraceEvents: 3000')
assertContains('server/release/freezeGuard.ts', 'maxMediaMetricEvents: 100')
assertContains('server/release/freezeGuard.ts', 'mediaMetricWindowMs: 10 * 60 * 1000')

for (const file of [
  'server/providers/bilibili/resolver/index.ts',
  'server/providers/bilibili/media/mediaResolver.ts',
  'server/providers/bilibili/authContext/contextBuilder.ts',
  'server/providers/bilibili/stability/retryManager.ts'
]) {
  assertNotContains(file, /process\.env\.(BILIBILI|PROVIDER|MEDIA|RESOLVER|STABILITY)_[A-Z0-9_]*_FLAG/, 'new runtime behavior flag')
}

assertContains('src/api/product/errorPresenter.ts', 'title')
assertContains('src/api/product/errorPresenter.ts', 'message')
assertContains('src/api/product/errorPresenter.ts', 'level')
assertContains('src/api/product/errorPresenter.ts', 'recoverable')
assertContains('src/api/product.ts', 'ProductUiTask')
assertContains('src/api/product.ts', 'assertProductUiTask')

console.log('[freeze-check] RC freeze contracts passed')
