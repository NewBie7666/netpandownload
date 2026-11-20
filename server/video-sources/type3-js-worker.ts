import { spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { isIP } from 'node:net'
import * as vm from 'node:vm'

type Action = 'home' | 'search' | 'detail' | 'play'

interface Candidate { label: string, code: string, url?: string }
interface RequestMessage {
  type: 'invoke'
  source: { id: string, apiUrl: string, configUrl?: string, flags?: string[] }
  ext: unknown
  candidates: Candidate[]
  modules: Array<{ url: string, code: string }>
  action: Action
  args: { keyword?: string, page?: number, id?: string, flag?: string }
}

const MAX_RESULT_BYTES = 1_500_000
const SCRIPT_TIMEOUT_MS = 4_000
const HTTP_TIMEOUT_MS = 10_000

class WorkerFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkerFailure'
    this.code = code
  }
}

function send(message: unknown): void {
  if (typeof process.send === 'function') process.send(message)
}

function fail(code: string, message: string): never {
  throw new WorkerFailure(code, message)
}

function publicIpv4(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113))
}

function publicIpv6(address: string): boolean {
  const first = Number.parseInt(address.toLowerCase().split(':')[0], 16)
  return first >= 0x2000 && first < 0x4000 && !address.toLowerCase().startsWith('2001:db8:')
}

function validateHttpUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('req 需要有效的 HTTP/HTTPS URL')
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !host || (!host.includes('.') && !isIP(host)) ||
      /(^|\.)(localhost|local|internal|test|invalid)$/u.test(host) ||
      (isIP(host) === 4 && !publicIpv4(host)) || (isIP(host) === 6 && !publicIpv6(host)) ||
      (url.port && Number(url.port) !== 80 && Number(url.port) !== 443)) {
    throw new Error('req 仅允许公开互联网 HTTP/HTTPS URL')
  }
  url.hash = ''
  return url
}

// req() is synchronous in many drpy rules. The rule VM cannot block its own
// event loop on an async fetch, so it invokes this tiny, separate Node process
// synchronously. The helper validates DNS answers and has its own timeout and
// response cap before returning JSON on stdout.
const HTTP_HELPER = String.raw`
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const isPublic = (address) => {
  const normalized = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    const [a,b,c] = normalized.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) { const first = Number.parseInt(normalized.split(':')[0], 16); return first >= 0x2000 && first < 0x4000 && !normalized.startsWith('2001:db8:'); }
  return false;
};
const maxBytes = 1500000;
const resolvePublic = async (url) => {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/g, '').toLowerCase();
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !host || (!host.includes('.') && !isIP(host)) || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw new Error('req URL 格式或主机不受支持');
  const addresses = await lookup(host, {all:true, verbatim:true});
  if (!addresses.length || addresses.some(item => !isPublic(item.address))) throw new Error('req URL DNS 不是公开地址');
  return addresses.sort((a,b) => a.family === 4 ? -1 : b.family === 4 ? 1 : 0);
};
const requestOnce = async (url, method, headers, body) => {
  const addresses = await resolvePublic(url);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const requestHeaders = {...headers};
    if (body !== undefined && body !== null && !Object.keys(requestHeaders).some(key => key.toLowerCase() === 'content-length')) requestHeaders['Content-Length'] = Buffer.byteLength(body);
    const req = transport(url, {
      agent: false,
      method,
      lookup: (_host, options, callback) => {
        if (options && options.all) callback(null, addresses.map(item => ({address:item.address, family:item.family})));
        else callback(null, addresses[0].address, addresses[0].family);
      },
      headers: requestHeaders,
      timeout: 10000,
      maxHeaderSize: 16384
    }, (response) => {
      const status = response.statusCode || 0;
      const location = Array.isArray(response.headers.location) ? '' : String(response.headers.location || '');
      if ([301,302,303,307,308].includes(status)) { response.resume(); finish(null, {status, headers:Object.fromEntries(Object.entries(response.headers).map(([key,value]) => [key, Array.isArray(value) ? value.join(',') : String(value || '')])), location, body:''}); return; }
      if (status < 200 || status > 299) { response.resume(); finish(new Error('req HTTP ' + status)); return; }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) { response.destroy(); finish(new Error('req 响应超过 1.5MB')); } else chunks.push(chunk); });
      response.on('end', () => finish(null, {status, headers:Object.fromEntries(Object.entries(response.headers).map(([key,value]) => [key, Array.isArray(value) ? value.join(',') : String(value || '')])), location:'', body:Buffer.concat(chunks).toString('utf8')}));
      response.on('error', (error) => finish(error));
    });
    req.setTimeout(10000, () => req.destroy(new Error('req 请求超时')));
    req.on('error', (error) => finish(error));
    if (body !== undefined) req.write(body);
    req.end();
  });
};
let url = new URL(request.url);
let method = request.method || 'GET';
let body = request.body;
let headers = request.headers && typeof request.headers === 'object' ? {...request.headers} : {};
let response;
for (let hop = 0; hop <= 3; hop++) {
  response = await requestOnce(url, method, headers, body);
  if (!response.location) break;
  if (hop === 3) throw new Error('req 重定向超过 3 次');
  const previousOrigin = url.origin;
  url = new URL(response.location, url);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('req 重定向目标不受支持');
  if (url.origin !== previousOrigin) {
    for (const key of Object.keys(headers)) if (['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) delete headers[key];
  }
  if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) { method = 'GET'; body = undefined; }
}
process.stdout.write(JSON.stringify({status: response.status, headers: response.headers, body: response.body}));
`

function syncReq(value: unknown, options?: unknown): unknown {
  const input = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : { url: value, ...(options as object || {}) }
  const url = validateHttpUrl(input.url)
  const headers = input.headers && typeof input.headers === 'object' ? input.headers : {}
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET'
  const body = input.body === undefined || input.body === null
    ? undefined
    : typeof input.body === 'string' ? input.body : JSON.stringify(input.body)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', HTTP_HELPER], {
    input: JSON.stringify({ url: url.toString(), method, headers, body }),
    encoding: 'utf8',
    timeout: HTTP_TIMEOUT_MS + 2_000,
    maxBuffer: 2_000_000,
    windowsHide: true,
    env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
  })
  if (result.error) throw new Error(`req 网络 helper 失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`req 网络 helper 失败：${String(result.stderr || '').slice(0, 500)}`)
  let response: {status: number, headers: Record<string, string>, body: string}
  try { response = JSON.parse(String(result.stdout)) as typeof response }
  catch { throw new Error('req 网络 helper 返回了无效响应') }
  const requestOptions = options && typeof options === 'object' ? options as Record<string, unknown> : input
  if (requestOptions.returnText || requestOptions.raw) return response.body
  const resultObject: Record<string, unknown> = {
    code: response.status,
    status: response.status,
    headers: response.headers,
    content: response.body,
    body: response.body
  }
  // Keep object-shaped drpy semantics while allowing legacy rules that
  // concatenate or JSON.parse(req(...)) to coerce it to the response body.
  Object.defineProperties(resultObject, {
    toString: { value: () => response.body, enumerable: false },
    valueOf: { value: () => response.body, enumerable: false }
  })
  return resultObject
}

function fallbackCryptoJs() {
  const bytesOf = (value: unknown): Buffer => Buffer.from(String(value ?? ''), 'utf8')
  const base64Encoder = {}
  const wordArray = (bytes: Buffer) => ({
    sigBytes: bytes.length,
    toString: (encoder?: unknown) => encoder === base64Encoder ? bytes.toString('base64') : bytes.toString('hex')
  })
  return {
    enc: {
      Hex: { parse: (value: string) => wordArray(Buffer.from(value, 'hex')) },
      Base64: { ...base64Encoder, parse: (value: string) => wordArray(Buffer.from(value, 'base64')), stringify: (value: {toString?: (encoder?: unknown) => string}) => value.toString?.(base64Encoder) || '' },
      Utf8: { parse: (value: string) => wordArray(Buffer.from(value, 'utf8')) }
    },
    MD5: (value: unknown) => wordArray(createHash('md5').update(bytesOf(value)).digest()),
    SHA1: (value: unknown) => wordArray(createHash('sha1').update(bytesOf(value)).digest()),
    SHA256: (value: unknown) => wordArray(createHash('sha256').update(bytesOf(value)).digest()),
    HmacSHA256: (value: unknown, key: unknown) => wordArray(createHmac('sha256', bytesOf(key)).update(bytesOf(value)).digest())
  }
}

const require = createRequire(import.meta.url)
const runtimeCheerio: any = (() => { try { return require('cheerio') } catch { return undefined } })()
const runtimeCryptoJs: any = (() => { try { return require('crypto-js') } catch { return undefined } })()
const CryptoJS: any = runtimeCryptoJs?.default || runtimeCryptoJs || fallbackCryptoJs()

function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/giu, '').replace(/<style[\s\S]*?<\/style>/giu, '').replace(/<[^>]+>/gu, '').replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/&#39;/giu, "'").replace(/\s+/gu, ' ').trim()
}

function selectorParts(selector: unknown, defaultField = 'Text'): { selector: string, field: string } {
  const parts = String(selector || '').split('&&').map(part => part.trim()).filter(Boolean)
  const field = parts.length > 1 ? parts.pop() as string : defaultField
  return { selector: parts.join(' ') || '*', field }
}

function htmlMatches(html: string, selector: string): string[] {
  const tagMatch = /^(?:([a-z][\w:-]*)|\*)(?:\.([\w-]+))?(?:#([\w-]+))?/iu.exec(selector.trim())
  if (!tagMatch) return []
  const tag = tagMatch[1] && tagMatch[1] !== '*' ? tagMatch[1] : '[a-z][\\w:-]*'
  const className = tagMatch[2]
  const id = tagMatch[3]
  const expression = new RegExp(`<(${tag})\\b([^>]*)>[\\s\\S]*?<\\/\\1>`, 'giu')
  return Array.from(html.matchAll(expression)).filter(match => {
    const attrs = match[2] || ''
    const classes = /\bclass\s*=\s*["']([^"']*)/iu.exec(attrs)?.[1] || ''
    const actualId = /\bid\s*=\s*["']([^"']*)/iu.exec(attrs)?.[1] || ''
    return (!className || new RegExp(`(?:^|\\s)${className}(?:\\s|$)`, 'u').test(classes)) && (!id || id === actualId)
  }).map(match => match[0])
}

function selectValue(html: string, selector: string, field: string): string {
  if (runtimeCheerio) {
    try {
      const $ = runtimeCheerio.load(html, { xmlMode: false })
      const selected = $(selector).first()
      if (!selected.length) return ''
      if (/^(?:text|txt)$/iu.test(field)) return selected.text().trim()
      return String(selected.attr(field) || (field === 'Html' ? selected.html() || '' : selected.text())).trim()
    } catch { /* use the bounded fallback below */ }
  }
  const match = htmlMatches(html, selector)[0] || ''
  if (!match) return ''
  if (/^(?:text|txt)$/iu.test(field)) return stripHtml(match)
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)`, 'iu').exec(match)?.[1] || stripHtml(match)
}

function pdfh(html: unknown, selector: unknown): string {
  const parts = selectorParts(selector)
  return selectValue(String(html || ''), parts.selector, parts.field)
}

function pdfa(html: unknown, selector: unknown): string[] {
  const source = String(html || '')
  // Unlike pdfh, pdfa normally receives only CSS segments: body&&.item.
  // Do not consume the last CSS segment as an attribute name.
  const segments = String(selector || '').split('&&').map(part => part.trim()).filter(Boolean)
  const explicitField = segments.length > 1 && /^(?:Text|Txt|Html|href|src|title|alt|value|id|class|style|content|poster|data-[\w-]+)$/i.test(segments.at(-1) || '')
  const field = explicitField ? segments.pop() as string : '__outerHtml__'
  const parts = { selector: segments.join(' ') || '*', field }
  if (runtimeCheerio) {
    try {
      const $ = runtimeCheerio.load(source, { xmlMode: false })
      return $(parts.selector).toArray().map((item: any) => {
        if (parts.field === '__outerHtml__') return String($.html(item))
        if (/^(?:text|txt)$/iu.test(parts.field)) return $(item).text().trim()
        if (parts.field === 'Html') return $(item).html() || ''
        return String($(item).attr(parts.field) || $.html(item))
      })
    } catch { /* use fallback */ }
  }
  return htmlMatches(source, parts.selector).map(item => parts.field === '__outerHtml__' ? item : /^(?:text|txt)$/iu.test(parts.field) ? stripHtml(item) : selectValue(item, '*', parts.field))
}

function pd(value: unknown, selector: unknown, base?: unknown): string {
  const result = pdfh(value, selector)
  if (!result) return ''
  try { return new URL(result, String(base || '')).toString() } catch { return result }
}

function joinUrl(base: unknown, value: unknown): string {
  try { return new URL(String(value || ''), String(base || '')).toString() } catch { return String(value || '') }
}

function requestText(value: unknown, options?: unknown): unknown {
  const requestOptions = options && typeof options === 'object' ? { ...(options as Record<string, unknown>), returnText: true } : { returnText: true }
  return syncReq(value, requestOptions)
}

function postText(value: unknown, options?: unknown): unknown {
  const requestOptions = options && typeof options === 'object'
    ? { ...(options as Record<string, unknown>), method: 'POST', returnText: true }
    : { method: 'POST', returnText: true }
  return syncReq(value, requestOptions)
}

function helperExports(): Record<string, unknown> {
  return { req: syncReq, request: requestText, fetch: requestText, post: postText, pdfh, pdfa, pd, joinUrl, urljoin: joinUrl, CryptoJS, cheerio: runtimeCheerio }
}

function createContext(message: RequestMessage): Record<string, unknown> {
  const context: Record<string, unknown> = Object.create(null)
  const safeConsole = { log() {}, info() {}, warn() {}, error() {} }
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} }
  Object.assign(context, {
    console: safeConsole,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    JSON,
    Math,
    Date,
    RegExp,
    module: moduleObject,
    exports: moduleObject.exports,
    ...helperExports()
  })
  context.globalThis = context
  context.global = context
  context.require = (name: unknown) => {
    if (name === 'crypto-js') return CryptoJS
    if (name === 'cheerio') return runtimeCheerio
    throw new Error(`不支持在 Type3 规则中 require ${String(name)}`)
  }
  context.__type3 = { source: message.source, ext: message.ext, args: message.args }
  return context
}

function moduleLooksLikeCode(code: string): boolean {
  return /(^|[;\n])\s*(?:import|export)\s*(?:[\s{*]|default\b)/u.test(code)
}

function exposeDrpyInput(code: string): string {
  // Some drpy rules execute their `搜索`/`一级` snippets through an eval
  // helper. In the VM module realm that eval can resolve `input` globally
  // instead of the searchParse local. Publish the exact MY_URL computed by
  // drpy (never a fabricated keyword) so those snippets retain their URL.
  return code.replace(/((?:var|let|const)\s+input\s*=\s*MY_URL\s*;?)/gu, '$1 globalThis.input = input;')
}

type ModuleNamespace = Record<string, unknown>

async function evaluateCandidate(code: string, label: string, context: Record<string, unknown>, vmContext: vm.Context, moduleSources: Map<string, string>): Promise<ModuleNamespace | undefined> {
  code = exposeDrpyInput(code)
  if (!moduleLooksLikeCode(code)) {
    const legacyCapture = `
;globalThis.__type3_legacy = {
  init: typeof init === 'function' ? init : undefined,
  home: typeof home === 'function' ? home : undefined,
  search: typeof search === 'function' ? search : undefined,
  detail: typeof detail === 'function' ? detail : undefined,
  play: typeof play === 'function' ? play : undefined,
  homeContent: typeof homeContent === 'function' ? homeContent : undefined,
  searchContent: typeof searchContent === 'function' ? searchContent : undefined,
  detailContent: typeof detailContent === 'function' ? detailContent : undefined,
  playerContent: typeof playerContent === 'function' ? playerContent : undefined,
  rule: typeof rule !== 'undefined' ? rule : undefined,
  Spider: typeof Spider !== 'undefined' ? Spider : undefined
};
`
    new vm.Script(code + legacyCapture, { filename: label }).runInContext(vmContext, { timeout: SCRIPT_TIMEOUT_MS })
    return (context.__type3_legacy || {}) as ModuleNamespace
  }

  const synthetic = new Map<string, vm.SyntheticModule>()
  const modules = new Map<string, vm.SourceTextModule>()
  const linker = async (specifier: string, referencingModule: vm.Module): Promise<vm.Module> => {
    if (!specifier.startsWith('assets://js/lib/') && specifier !== 'crypto-js') {
      const reference = String((referencingModule as unknown as {identifier?: string}).identifier || label)
      let resolved: string
      try { resolved = new URL(specifier, reference).toString() } catch { throw new Error(`Type3 JavaScript import 无法解析：${specifier}`) }
      const moduleCode = moduleSources.get(resolved)
      if (moduleCode === undefined) throw new Error(`Type3 JavaScript 依赖未预取：${resolved}`)
      const existingModule = modules.get(resolved)
      if (existingModule) return existingModule
      const dependency = new vm.SourceTextModule(moduleCode, {
        context: vmContext,
        identifier: resolved,
        initializeImportMeta(meta) { meta.url = resolved }
      })
      modules.set(resolved, dependency)
      await dependency.link(linker)
      return dependency
    }
    const existing = synthetic.get(specifier)
    if (existing) return existing
    const helpers = helperExports()
    const exportNames = specifier === 'crypto-js' ? ['default', 'CryptoJS'] : [...Object.keys(helpers), 'default']
    const module = new vm.SyntheticModule(exportNames, function () {
      if (specifier === 'crypto-js') {
        this.setExport('default', CryptoJS)
        this.setExport('CryptoJS', CryptoJS)
      } else {
        for (const name of Object.keys(helpers)) this.setExport(name, helpers[name])
        this.setExport('default', specifier.includes('cheerio') ? runtimeCheerio : helpers)
      }
    }, { context: vmContext, identifier: specifier })
    synthetic.set(specifier, module)
    return module
  }
  const module = new vm.SourceTextModule(code, {
    context: vmContext,
    identifier: label,
    initializeImportMeta(meta) { meta.url = label }
  })
  await module.link(linker)
  await module.evaluate({ timeout: SCRIPT_TIMEOUT_MS })
  const namespace = module.namespace as unknown as Record<string, unknown>
  return Object.fromEntries(Object.keys(namespace).map(key => [key, namespace[key]]))
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function collectHandlers(namespaces: ModuleNamespace[], context: Record<string, unknown>): Record<string, unknown> {
  const handlers: Record<string, unknown> = {}
  const add = (value: unknown) => {
    const object = asObject(value)
    if (!object) return
    for (const key of ['init', 'home', 'search', 'detail', 'play', 'homeContent', 'searchContent', 'detailContent', 'playerContent']) {
      if (handlers[key] === undefined && typeof object[key] === 'function') handlers[key] = object[key]
    }
  }
  for (const namespace of namespaces) {
    add(namespace)
    add(namespace.default)
    add(namespace.rule)
    add(namespace.Spider)
  }
  add(context.__type3_legacy)
  add(asObject(context.module)?.exports)
  add(context.exports)
  add(context.rule)
  add(context.Spider)
  for (const key of ['init', 'home', 'search', 'detail', 'play', 'homeContent', 'searchContent', 'detailContent', 'playerContent']) {
    if (handlers[key] === undefined && typeof context[key] === 'function') handlers[key] = context[key]
  }
  return handlers
}

async function invokeHandler(fn: (...args: unknown[]) => unknown, name: string, action: Action, args: RequestMessage['args'], flags?: string[]): Promise<unknown> {
  if (action === 'home') {
    if (name === 'homeContent') return fn.length ? await fn(true) : await fn()
    return fn.length ? await fn(args) : await fn()
  }
  if (action === 'search') {
    if (fn.length >= 3) return await fn(args.keyword || '', false, args.page || 1)
    if (fn.length === 2) return await fn(args.keyword || '', args.page || 1)
    if (fn.length === 1) return await fn(args.keyword || '')
    return await fn()
  }
  if (action === 'detail') {
    if (name === 'detailContent') return fn.length ? await fn([args.id || '']) : await fn()
    return fn.length ? await fn(args.id || '') : await fn()
  }
  if (fn.length >= 3) return await fn(args.flag || '', args.id || '', flags || [])
  if (fn.length === 2) return await fn(args.flag || '', args.id || '')
  if (fn.length === 1) return await fn(args)
  return await fn()
}

function emptyResult(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return true
    if (text.startsWith('{') || text.startsWith('[')) {
      try { return emptyResult(JSON.parse(text)) } catch { /* non-JSON string is a valid result */ }
    }
    return false
  }
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}

function seedSearchInput(context: Record<string, unknown>, args: RequestMessage['args']): void {
  const rule = asObject(context.rule)
  if (!rule) return
  const template = typeof rule.searchUrl === 'string' ? rule.searchUrl : undefined
  if (!template) return
  let value = template.replaceAll('**', args.keyword || '').replaceAll('fypage', String(args.page || 1))
  if (typeof rule.host === 'string' && !/^https?:\/\//iu.test(value)) value = joinUrl(rule.host, value)
  context.input = value
}

async function execute(message: RequestMessage): Promise<unknown> {
  if (!Array.isArray(message.candidates) || !message.candidates.length) fail('type3_js_rule_unavailable', '没有可执行的 Type3 JavaScript 规则')
  const context = createContext(message)
  // drpy2 deliberately evaluates rule snippets (hostJs/预处理/模板). Keep
  // string code generation inside the disposable worker; the parent controls
  // the worker lifetime and timeout. VM code-generation restrictions are not
  // a security sandbox (the worker exposes selected host helpers).
  const vmContext = vm.createContext(context, { codeGeneration: { strings: true, wasm: false } })
  const moduleSources = new Map((message.modules || []).map(module => [module.url, module.code]))
  const namespaces: ModuleNamespace[] = []
  const errors: string[] = []
  for (const candidate of message.candidates) {
    try {
      const namespace = await evaluateCandidate(candidate.code, candidate.url || candidate.label, context, vmContext, moduleSources)
      if (namespace) namespaces.push(namespace)
    } catch (error) {
      errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const handlers = collectHandlers(namespaces, context)
  const init = handlers.init
  if (typeof init === 'function') {
    try {
      const initialized = await (init as (...args: unknown[]) => unknown)(message.ext)
      const initializedHandlers = asObject(initialized)
      if (initializedHandlers) {
        for (const [key, value] of Object.entries(initializedHandlers)) {
          if (handlers[key] === undefined && typeof value === 'function') handlers[key] = value
        }
      }
    } catch (error) {
      fail('type3_js_init_failed', `Type3 JavaScript init 执行失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Legacy rule snippets sometimes run through an indirect eval and cannot
  // see searchParse's local input; derive the same URL from the loaded rule.
  if (message.action === 'search') seedSearchInput(context, message.args || {})
  const methodNames: Record<Action, string[]> = {
    home: ['home', 'homeContent'],
    search: ['search', 'searchContent'],
    detail: ['detail', 'detailContent'],
    play: ['play', 'playerContent']
  }
  const selected = methodNames[message.action].map(name => ({ name, method: handlers[name] })).find(value => typeof value.method === 'function')
  if (!selected) {
    const detail = errors.length ? `；规则错误：${errors.join('；').slice(0, 1000)}` : ''
    fail('type3_js_unsupported_shape', `Type3 JavaScript 规则未提供 ${message.action} 方法（支持 default 导出对象或全局 init/home/search/detail/play）${detail}`)
  }
  let result: unknown
  try {
    result = await invokeHandler(selected.method as (...args: unknown[]) => unknown, selected.name, message.action, message.args || {}, message.source.flags)
  } catch (error) {
    fail('type3_js_runtime_error', `Type3 JavaScript ${message.action} 执行失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (emptyResult(result)) fail('type3_js_empty_result', `Type3 JavaScript ${message.action} 返回空结果，未视为兼容成功`)
  try {
    const serialized = JSON.stringify(result)
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) fail('type3_js_result_too_large', 'Type3 JavaScript 返回结果超过 1.5MB 或不可序列化')
  } catch (error) {
    if (error instanceof WorkerFailure) throw error
    fail('type3_js_result_invalid', `Type3 JavaScript 返回结果不可序列化：${error instanceof Error ? error.message : String(error)}`)
  }
  return result
}

async function run(): Promise<void> {
  process.once('message', async (message: RequestMessage) => {
    try {
      if (!message || message.type !== 'invoke') fail('type3_js_protocol_error', 'Type3 JavaScript 请求消息无效')
      const result = await execute(message)
      send({ type: 'result', result })
    } catch (error) {
      if (error instanceof WorkerFailure) send({ type: 'error', code: error.code, message: error.message })
      else send({ type: 'error', code: 'type3_js_runtime_error', message: error instanceof Error ? error.message : String(error) })
    }
  })
}

void run()
