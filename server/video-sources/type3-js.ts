import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fetchVideoSourceText } from './network.js'

export type Type3JavaScriptAction = 'home' | 'search' | 'detail' | 'play'

export interface Type3JavaScriptSource {
  id: string
  apiUrl: string
  ext?: unknown
  configUrl?: string
  flags?: string[]
}

export interface Type3JavaScriptArgs {
  keyword?: string
  page?: number
  id?: string
  flag?: string
}

export class Type3JavaScriptError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'Type3JavaScriptError'
    this.code = code
  }
}

interface RuleCandidate {
  label: string
  code: string
  url?: string
}

interface RuleModule {
  url: string
  code: string
}

interface RuleBundle {
  candidates: RuleCandidate[]
  modules: RuleModule[]
}

interface WorkerRequest {
  type: 'invoke'
  source: Pick<Type3JavaScriptSource, 'id' | 'apiUrl' | 'configUrl' | 'flags'>
  ext: unknown
  candidates: RuleCandidate[]
  modules: RuleModule[]
  action: Type3JavaScriptAction
  args: Type3JavaScriptArgs
}

interface WorkerSuccess { type: 'result', result: unknown }
interface WorkerFailure { type: 'error', code: string, message: string }

const MAX_RULE_BYTES = 1_500_000
const MAX_RESULT_BYTES = 1_500_000
const EXECUTION_TIMEOUT_MS = 15_000
const MAX_DIAGNOSTIC_BYTES = 32_000
const MAX_RULE_MODULES = 20
const MAX_RULE_TOTAL_BYTES = 30 * 1024 * 1024
const RULE_CACHE_TTL_MS = 5 * 60 * 1000

interface CachedRule {
  code: string
  expiresAt: number
  bytes: number
}

const ruleCache = new Map<string, CachedRule>()
let ruleCacheBytes = 0

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function looksLikeJavaScript(value: string): boolean {
  const text = value.trim()
  if (!text || text.length > MAX_RULE_BYTES) return false
  return /^(?:#!.*\r?\n)?\s*(?:(?:import|export)\s*(?:[\s{*]|default\b)|(?:const|let|var|function|class)\s|[([{]\s*(?:["']?(?:init|home|search|detail|play|rule|sites?)|default)\s*:)/.test(text) ||
    /(?:globalThis|module\.exports|exports\.|pdfh\(|pdfa\(|req\()/.test(text)
}

function workerPath(): string {
  const modulePath = fileURLToPath(import.meta.url)
  return modulePath.endsWith('.ts')
    ? modulePath.replace(/type3-js\.ts$/u, 'type3-js-worker.ts')
    : modulePath.replace(/type3-js\.js$/u, 'type3-js-worker.js')
}

function childExecArgv(): string[] {
  // tsx adds its loader through --require/--import. Keep those entries, but
  // never forward the parent command's -e/--eval/test mode to fork().
  const args = [...process.execArgv]
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-e' || arg === '--eval' || arg === '--print' || arg === '-p' || arg === '--input-type') {
      index += 1
      continue
    }
    if (arg === '--test' || arg === '--input-type=module' || arg === '--input-type=commonjs') continue
    if (arg === '--watch' || arg === '--watch-path') {
      if (arg === '--watch-path') index += 1
      continue
    }
    filtered.push(arg)
  }
  if (!filtered.includes('--experimental-vm-modules')) filtered.push('--experimental-vm-modules')
  return filtered
}

function safeDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.length > MAX_DIAGNOSTIC_BYTES ? text.slice(0, MAX_DIAGNOSTIC_BYTES) + '…' : text
}

async function loadRuleCandidates(source: Type3JavaScriptSource): Promise<RuleBundle> {
  const candidates: RuleCandidate[] = []
  const inlineCandidates: RuleCandidate[] = []
  const seen = new Set<string>()
  const addInline = (label: string, value: unknown) => {
    if (typeof value !== 'string' || !looksLikeJavaScript(value)) return
    const code = value.trim()
    if (Buffer.byteLength(code, 'utf8') > MAX_RULE_BYTES) {
      throw new Type3JavaScriptError('type3_js_rule_too_large', `${label} JavaScript 规则超过 1.5MB`)
    }
    inlineCandidates.push({ label, code })
  }

  // Some TVBox configurations put the complete rule in ext. Keep this path
  // first so a symbolic api value such as csp_Drpy is never fetched as a URL.
  addInline('ext:inline', source.ext)
  if (source.ext && typeof source.ext === 'object' && !Array.isArray(source.ext)) {
    const objectExt = source.ext as Record<string, unknown>
    addInline('ext:code', objectExt.code)
    addInline('ext:js', objectExt.js)
  }

  const fetchRule = async (url: string): Promise<string> => {
    const cached = ruleCache.get(url)
    if (cached && cached.expiresAt > Date.now()) return cached.code
    if (cached) ruleCacheBytes -= cached.bytes
    ruleCache.delete(url)
    const code = await fetchVideoSourceText(url)
    const bytes = Buffer.byteLength(code, 'utf8')
    if (bytes > MAX_RULE_BYTES) throw new Type3JavaScriptError('type3_js_rule_too_large', 'JavaScript 规则超过 1.5MB')
    while (ruleCache.size >= 20 || ruleCacheBytes + bytes > MAX_RULE_TOTAL_BYTES) {
      const oldest = ruleCache.keys().next().value as string | undefined
      if (!oldest) break
      const removed = ruleCache.get(oldest)
      if (removed) ruleCacheBytes -= removed.bytes
      ruleCache.delete(oldest)
    }
    ruleCache.set(url, { code, bytes, expiresAt: Date.now() + RULE_CACHE_TTL_MS })
    ruleCacheBytes += bytes
    return code
  }
  const errors: string[] = []
  const addFetched = async (label: string, value: unknown) => {
    if (!isHttpUrl(value) || seen.has(value)) return
    seen.add(value)
    try {
      const code = await fetchRule(value)
      candidates.push({ label, code, url: value })
    } catch (error) {
      errors.push(`${label}: ${safeDiagnostic(error)}`)
    }
  }

  // apiUrl is the drpy/engine module and must be evaluated before the site
  // rule. configUrl is the TVBox JSON document URL, not executable JavaScript.
  await addFetched('api', source.apiUrl)
  candidates.push(...inlineCandidates)
  await addFetched('ext', typeof source.ext === 'string' ? source.ext : undefined)

  if (!candidates.length) {
    const suffix = errors.length ? `（${errors.join('；')}）` : ''
    throw new Type3JavaScriptError(
      'type3_js_rule_unavailable',
      `没有找到可执行的 Type3 JavaScript 规则${suffix}`
    )
  }
  const modules: RuleModule[] = []
  const queue = candidates.filter(candidate => candidate.url).map(candidate => ({ url: candidate.url as string, code: candidate.code }))
  const moduleUrls = new Set(queue.map(item => item.url))
  let totalBytes = queue.reduce((total, item) => total + Buffer.byteLength(item.code, 'utf8'), 0)
  while (queue.length && modules.length < MAX_RULE_MODULES) {
    const current = queue.shift() as { url: string, code: string }
    const importSpecifiers = new Set<string>()
    for (const expression of [
      /\bimport\s*["']([^"']+)["']/gu,
      /\bimport\s*(?!["'])[\s\S]*?\s*from\s*["']([^"']+)["']/gu,
      /\bexport\s*(?:[\s\S]*?\s*from\s*)["']([^"']+)["']/gu
    ]) {
      for (const match of current.code.matchAll(expression)) importSpecifiers.add(match[1])
    }
    for (const specifier of importSpecifiers) {
      if (specifier.startsWith('assets://') || specifier === 'crypto-js' || specifier.startsWith('node:')) continue
      let resolved: URL
      try { resolved = new URL(specifier, current.url) } catch { continue }
      if (!isHttpUrl(resolved.toString()) || moduleUrls.has(resolved.toString())) continue
      if (moduleUrls.size >= MAX_RULE_MODULES || totalBytes >= MAX_RULE_TOTAL_BYTES) {
        errors.push(`依赖模块超过 ${MAX_RULE_MODULES} 个或 30MB 上限`)
        continue
      }
      moduleUrls.add(resolved.toString())
      try {
        const code = await fetchRule(resolved.toString())
        const bytes = Buffer.byteLength(code, 'utf8')
        if (totalBytes + bytes > MAX_RULE_TOTAL_BYTES) {
          errors.push(`依赖 ${specifier} 使规则总大小超过 30MB 上限`)
          continue
        }
        totalBytes += bytes
        modules.push({ url: resolved.toString(), code })
        queue.push({ url: resolved.toString(), code })
      } catch (error) {
        errors.push(`依赖 ${specifier}: ${safeDiagnostic(error)}`)
      }
    }
  }
  // The worker receives modules over IPC; attach them without changing the
  // public invoke signature. A non-empty candidate is still required above.
  return { candidates, modules }
}

function childError(error: unknown): Type3JavaScriptError {
  if (error instanceof Type3JavaScriptError) return error
  return new Type3JavaScriptError('type3_js_worker_failed', safeDiagnostic(error))
}

function killChild(child: ChildProcess): void {
  try { child.kill() } catch { /* the child may already have exited */ }
}

/**
 * Execute one TVBox Type=3 JavaScript operation outside the server process.
 * Rule text is fetched through the public-DNS-pinned source client and then
 * evaluated in type3-js-worker.ts, where only explicitly exposed helpers are
 * available to the rule. The worker VM is not a security sandbox; the child
 * process and parent-controlled timeout are the isolation/lifetime boundary.
 */
export async function invokeJavaScriptSource(
  source: Type3JavaScriptSource,
  action: Type3JavaScriptAction,
  args: Type3JavaScriptArgs = {}
): Promise<unknown> {
  if (!source || typeof source !== 'object' || typeof source.id !== 'string' || !source.id.trim()) {
    throw new Type3JavaScriptError('type3_js_invalid_source', 'Type3 JavaScript 源缺少有效 id')
  }
  if (typeof source.apiUrl !== 'string' || source.apiUrl.length > 2048) {
    throw new Type3JavaScriptError('type3_js_invalid_source', 'Type3 JavaScript 源 api 地址无效')
  }
  if (!['home', 'search', 'detail', 'play'].includes(action)) {
    throw new Type3JavaScriptError('type3_js_invalid_action', 'Type3 JavaScript 操作不受支持')
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Type3JavaScriptError('type3_js_invalid_args', 'Type3 JavaScript 操作参数无效')
  }

  const bundle = await loadRuleCandidates(source)
  const request: WorkerRequest = {
    type: 'invoke',
    source: {
      id: source.id,
      apiUrl: source.apiUrl,
      configUrl: source.configUrl,
      flags: source.flags
    },
    ext: source.ext,
    candidates: bundle.candidates,
    modules: bundle.modules,
    action,
    args
  }

  const electron = Boolean(process.versions.electron)
  const child = fork(workerPath(), [], {
    detached: false,
    execArgv: childExecArgv(),
    env: electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })

  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => {
    if (stderr.length < MAX_DIAGNOSTIC_BYTES) stderr += String(chunk).slice(0, MAX_DIAGNOSTIC_BYTES - stderr.length)
  })
  child.stdout?.resume()

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killChild(child)
      reject(new Type3JavaScriptError('type3_js_timeout', `Type3 JavaScript 执行超过 ${EXECUTION_TIMEOUT_MS}ms`))
    }, EXECUTION_TIMEOUT_MS)

    const finish = (error?: Type3JavaScriptError, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }

    child.once('error', error => finish(new Type3JavaScriptError('type3_js_worker_failed', safeDiagnostic(error))))
    child.once('exit', (code, signal) => {
      if (settled) return
      const detail = stderr.trim() ? `：${safeDiagnostic(stderr.trim())}` : ''
      finish(new Type3JavaScriptError(
        'type3_js_worker_exit',
        `Type3 JavaScript 子进程异常退出（code=${String(code)} signal=${String(signal)}）${detail}`
      ))
    })
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') {
        finish(new Type3JavaScriptError('type3_js_protocol_error', 'Type3 JavaScript 子进程返回了无效消息'))
        killChild(child)
        return
      }
      const response = message as { type?: unknown, code?: unknown, message?: unknown, result?: unknown }
      if (response.type === 'error') {
        finish(new Type3JavaScriptError(
          typeof response.code === 'string' ? response.code : 'type3_js_runtime_error',
          typeof response.message === 'string' ? response.message : 'Type3 JavaScript 运行失败'
        ))
        killChild(child)
        return
      }
      if (response.type !== 'result') {
        finish(new Type3JavaScriptError('type3_js_protocol_error', 'Type3 JavaScript 子进程返回了未知消息'))
        killChild(child)
        return
      }
      try {
        const serialized = JSON.stringify(response.result)
        if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
          throw new Type3JavaScriptError('type3_js_result_too_large', 'Type3 JavaScript 返回结果超过 1.5MB 或不可序列化')
        }
      } catch (error) {
        finish(childError(error))
        killChild(child)
        return
      }
      finish(undefined, response.result)
      killChild(child)
    })

    try {
      child.send(request, error => {
        if (error) finish(new Type3JavaScriptError('type3_js_worker_failed', safeDiagnostic(error)))
      })
    } catch (error) {
      finish(new Type3JavaScriptError('type3_js_worker_failed', safeDiagnostic(error)))
      killChild(child)
    }
  })
}
