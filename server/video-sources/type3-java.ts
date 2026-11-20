import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, realpath, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from '../http.js'
import { fetchVideoSourceBytes } from './network.js'

/** A type=3 site whose implementation is a desktop-compatible JVM Spider. */
export interface JavaVideoSource {
  id: string
  apiUrl: string
  spider?: string
  ext?: unknown
  configUrl?: string
  flags?: string[]
  /**
   * Optional server-side fixture/administrator override. It is ignored unless
   * NETPAN_TYPE3_TRUSTED_JAR_ROOT is set and the resolved file stays below it;
   * browser/imported source data must never be allowed to choose local paths.
   */
  jarPath?: string
  trustedJarPath?: string
}

export type JavaInvokeAction = 'home' | 'search' | 'detail' | 'play'

export interface JavaInvokeArgs {
  keyword?: string
  page?: number
  id?: string
  flag?: string
}

export interface Type3ArchiveInfo {
  kind: 'dex' | 'jar'
  entries: string[]
  hasNativeLibrary: boolean
}

interface JavaRuntime {
  root: string
  java: string
  stubs: string
  runnerClasspath: string
  libraries: string[]
  d2jLibraries: string[]
}

interface SpiderSpec {
  url: string
  expectedMd5?: string
}

interface SpiderCacheIndex {
  url: string
  expectedMd5?: string
  sha256: string
  fetchedAt: number
}

const MAX_SPIDER_BYTES = 32 * 1024 * 1024
const MAX_JAVA_STDOUT = 2 * 1024 * 1024
const MAX_JAVA_STDERR = 2 * 1024 * 1024
const JAVA_TIMEOUT_MS = 90_000
const DEX2JAR_TIMEOUT_MS = 180_000
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

function appError(code: string, message: string, status = 422): AppError {
  return new AppError(code, message, status)
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function md5(value: Uint8Array): string {
  return createHash('md5').update(value).digest('hex')
}

function isSafeDigest(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value)
}

function parseSpiderSpec(value: unknown): SpiderSpec {
  if (typeof value !== 'string' || !value.trim()) {
    throw appError('type3_java_spider_missing', 'JVM Spider 源缺少 spider 下载地址')
  }
  const parts = value.split(';').map(part => part.trim())
  const url = parts.shift() || ''
  if (!/^https?:\/\//i.test(url)) {
    throw appError('type3_java_spider_invalid', 'JVM Spider 只允许 HTTP/HTTPS 下载地址')
  }
  let expectedMd5: string | undefined
  if (parts[0]?.toLowerCase() === 'md5') {
    const digest = parts[1]
    if (digest && !isSafeDigest(digest)) throw appError('type3_java_spider_invalid', 'JVM Spider MD5 校验值格式错误')
    expectedMd5 = digest?.toLowerCase()
  } else if (parts[0]) {
    if (!isSafeDigest(parts[0])) throw appError('type3_java_spider_invalid', 'JVM Spider 校验值格式错误')
    expectedMd5 = parts[0].toLowerCase()
  }
  return { url, expectedMd5 }
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000)) >>> 0
}

/**
 * Reads ZIP central-directory names without extracting untrusted content.
 * TVBox Spider packages are APK/JAR-shaped ZIPs; this is enough to identify
 * DEX and native payloads before a converter or JVM ever sees them.
 */
interface ZipEntry {
  name: string
  nameBytes: Buffer
  method: number
  flags: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  data: Buffer
}

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const min = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= min; offset--) {
    if (readUInt32(bytes, offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return []
  const count = readUInt16(bytes, eocd + 10)
  const directorySize = readUInt32(bytes, eocd + 12)
  const directoryOffset = readUInt32(bytes, eocd + 16)
  if (count > 20_000 || directoryOffset + directorySize > bytes.length) {
    throw appError('type3_java_archive_invalid', 'JVM Spider ZIP 目录无效')
  }
  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index++) {
    if (readUInt32(bytes, cursor) !== 0x02014b50) throw appError('type3_java_archive_invalid', 'JVM Spider ZIP 条目无效')
    const flags = readUInt16(bytes, cursor + 8)
    const method = readUInt16(bytes, cursor + 10)
    const crc = readUInt32(bytes, cursor + 16)
    const compressedSize = readUInt32(bytes, cursor + 20)
    const uncompressedSize = readUInt32(bytes, cursor + 24)
    const nameLength = readUInt16(bytes, cursor + 28)
    const extraLength = readUInt16(bytes, cursor + 30)
    const commentLength = readUInt16(bytes, cursor + 32)
    const start = cursor + 46
    const end = start + nameLength
    if (end > bytes.length) throw appError('type3_java_archive_invalid', 'JVM Spider ZIP 文件名越界')
    const nameBytes = Buffer.from(bytes.subarray(start, end))
    const localOffset = readUInt32(bytes, cursor + 42)
    if (localOffset + 30 > bytes.length || readUInt32(bytes, localOffset) !== 0x04034b50) {
      throw appError('type3_java_archive_invalid', 'JVM Spider ZIP 本地条目无效')
    }
    const localNameLength = readUInt16(bytes, localOffset + 26)
    const localExtraLength = readUInt16(bytes, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length) throw appError('type3_java_archive_invalid', 'JVM Spider ZIP 数据越界')
    entries.push({ name: nameBytes.toString('utf8'), nameBytes, method, flags, crc,
      compressedSize, uncompressedSize, data: Buffer.from(bytes.subarray(dataStart, dataEnd)) })
    cursor = end + extraLength + commentLength
    if (cursor > bytes.length) throw appError('type3_java_archive_invalid', 'JVM Spider ZIP 目录越界')
  }
  return entries
}

function zipEntryNames(bytes: Uint8Array): string[] {
  return zipEntries(bytes).map(entry => entry.name)
}

/** Exported for focused tests and diagnostics; it never executes the archive. */
export function inspectType3Archive(bytes: Uint8Array): Type3ArchiveInfo {
  const raw = Buffer.from(bytes)
  if (raw.subarray(0, 4).toString('ascii') === 'dex\n') {
    return { kind: 'dex', entries: ['classes.dex'], hasNativeLibrary: false }
  }
  const names = zipEntryNames(raw)
  if (!names.length) throw appError('type3_java_archive_invalid', 'JVM Spider 不是可识别的 DEX/JAR/ZIP')
  const lower = names.map(name => name.toLowerCase())
  const hasDex = lower.some(name => name === 'classes.dex' || name.endsWith('.dex'))
  const hasNativeLibrary = lower.some(name => name.endsWith('.so') || name.includes('/lib/') && name.endsWith('.dll'))
  if (!hasDex && !lower.some(name => name.endsWith('.class'))) {
    throw appError('type3_java_archive_invalid', 'JVM Spider ZIP 不包含 classes.dex 或 JVM class')
  }
  return { kind: hasDex ? 'dex' : 'jar', entries: names, hasNativeLibrary }
}

function classNameForApi(api: unknown): string {
  if (typeof api !== 'string' || !api.trim()) throw appError('type3_java_api_invalid', 'JVM Spider 缺少 api 类名')
  let name = api.trim()
  if (name.startsWith('csp_')) name = name.slice(4)
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(name)) {
    throw appError('type3_java_api_invalid', 'JVM Spider api 类名格式错误')
  }
  return name.includes('.') ? name : 'com.github.catvod.spider.' + name
}

/** Exported for tests and for the provider's Type3 capability report. */
export { classNameForApi }

function runtimeCandidates(): string[] {
  const candidates: string[] = []
  const add = (value: string | undefined) => {
    if (!value) return
    const resolved = path.resolve(value)
    if (!candidates.includes(resolved)) candidates.push(resolved)
  }
  const configuredRoot = String(process.env.NETPAN_TYPE3_JAVA_ROOT || '').trim()
  if (configuredRoot) {
    add(configuredRoot)
    return candidates
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath) {
    add(path.join(resourcesPath, 'type3', 'java'))
    add(path.join(resourcesPath, 'resources', 'type3', 'java'))
  }
  add(path.join(process.cwd(), 'resources', 'type3', 'java'))
  const current = path.dirname(fileURLToPath(import.meta.url))
  add(path.join(current, '..', '..', 'resources', 'type3', 'java'))
  add(path.join(current, '..', '..', '..', 'resources', 'type3', 'java'))
  const javaHome = process.env.JAVA_HOME
  if (javaHome) add(javaHome)
  return candidates
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find(candidate => existsSync(candidate))
}

async function resolveRuntime(): Promise<JavaRuntime> {
  for (const root of runtimeCandidates()) {
    const java = firstExisting([
      path.join(root, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
      path.join(root, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
      path.join(root, process.platform === 'win32' ? 'java.exe' : 'java')
    ])
    const stubs = path.join(root, 'stubs', 'stubs.jar')
    const runnerDirectory = path.join(root, 'runner')
    const runnerClass = path.join(runnerDirectory, 'NetPanSpiderRunner.class')
    const runnerJar = path.join(runnerDirectory, 'NetPanSpiderRunner.jar')
    const runnerClasspath = existsSync(runnerClass) ? runnerDirectory : runnerJar
    if (!java || !existsSync(stubs) || !existsSync(runnerClasspath)) continue
    const libraryRoot = path.join(root, 'libs')
    const d2jRoot = path.join(root, 'd2j')
    const libraries = existsSync(libraryRoot)
      ? (await readdir(libraryRoot)).filter(file => file.toLowerCase().endsWith('.jar')).sort().map(file => path.join(libraryRoot, file))
      : []
    const d2jLibraries = existsSync(d2jRoot)
      ? (await readdir(d2jRoot)).filter(file => file.toLowerCase().endsWith('.jar')).sort().map(file => path.join(d2jRoot, file))
      : []
    return { root, java, stubs, runnerClasspath, libraries, d2jLibraries }
  }
  throw appError('type3_java_runtime_missing', 'Windows JVM Type3 运行时未安装，请先准备 JRE、Android 桩和 Runner', 503)
}

function dataRoot(): string {
  const configured = String(process.env.NETPAN_DATA_DIR || '').trim()
  if (configured) return path.resolve(configured)
  return path.join(homedir(), '.netpandownload')
}

async function atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function readIndex(file: string): Promise<SpiderCacheIndex | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<SpiderCacheIndex>
    if (typeof value.url !== 'string' || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256) ||
        typeof value.fetchedAt !== 'number') return undefined
    return { url: value.url, expectedMd5: typeof value.expectedMd5 === 'string' ? value.expectedMd5 : undefined,
      sha256: value.sha256.toLowerCase(), fetchedAt: value.fetchedAt }
  } catch { return undefined }
}

async function cacheSpider(spec: SpiderSpec): Promise<{ file: string, info: Type3ArchiveInfo }> {
  const root = path.join(dataRoot(), 'type3', 'java')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const specKey = sha256(spec.url + '|' + (spec.expectedMd5 || ''))
  const indexFile = path.join(root, specKey + '.json')
  const index = await readIndex(indexFile)
  if (index && index.url === spec.url && index.expectedMd5 === spec.expectedMd5 && Date.now() - index.fetchedAt < CACHE_TTL_MS) {
    const cached = path.join(root, index.sha256 + '.archive')
    try {
      const bytes = await readFile(cached)
      if (sha256(bytes) === index.sha256 && (!spec.expectedMd5 || md5(bytes) === spec.expectedMd5)) {
        return { file: cached, info: inspectType3Archive(bytes) }
      }
    } catch { /* stale or partially written cache; fetch again */ }
  }

  const bytes = await fetchVideoSourceBytes(spec.url, MAX_SPIDER_BYTES)
  if (spec.expectedMd5 && md5(bytes) !== spec.expectedMd5) {
    throw appError('type3_java_spider_checksum', 'JVM Spider MD5 校验失败，已拒绝执行', 422)
  }
  const contentHash = sha256(bytes)
  const archiveFile = path.join(root, contentHash + '.archive')
  let cacheValid = false
  if (existsSync(archiveFile)) {
    try { cacheValid = sha256(await readFile(archiveFile)) === contentHash }
    catch { cacheValid = false }
  }
  if (!cacheValid) await atomicWrite(archiveFile, bytes)
  await atomicWrite(indexFile, JSON.stringify({ url: spec.url, expectedMd5: spec.expectedMd5, sha256: contentHash, fetchedAt: Date.now() }))
  return { file: archiveFile, info: inspectType3Archive(bytes) }
}

interface BoundedResult { code: number | null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean }

function runBounded(file: string, args: string[], options: { cwd?: string, timeoutMs: number, maxStdout: number, maxStderr: number }): Promise<BoundedResult> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, { cwd: options.cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const limit = target === 'stdout' ? options.maxStdout : options.maxStderr
      const current = target === 'stdout' ? stdout : stderr
      const remaining = Math.max(0, limit - Buffer.byteLength(current, 'utf8'))
      const text = chunk.subarray(0, remaining).toString('utf8')
      if (target === 'stdout') stdout += text
      else stderr += text
      if (chunk.length > remaining) {
        truncated = true
        child.kill()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
    const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, truncated })
    })
  })
}

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16LE(value & 0xffff, 0)
  return bytes
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value >>> 0, 0)
  return bytes
}

/** Rebuilds a ZIP while retaining each entry's already-compressed payload. */
function buildZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = entry.nameBytes
    const flags = entry.flags & ~0x0008
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(entry.method), u16(0), u16(0), u32(entry.crc),
      u32(entry.compressedSize), u32(entry.uncompressedSize), u16(name.length), u16(0), name
    ])
    local.push(header, entry.data)
    const directory = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(entry.method), u16(0), u16(0), u32(entry.crc),
      u32(entry.compressedSize), u32(entry.uncompressedSize), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), name
    ])
    central.push(directory)
    offset += header.length + entry.data.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0)
  ])
  return Buffer.concat([...local, centralBytes, end])
}

function isResourceEntry(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === 'classes.dex' || lower.endsWith('.dex') || lower.endsWith('.class')) return false
  if (/^meta-inf\/[^/]+\.(sf|rsa|dsa|ec)$/i.test(name)) return false
  return true
}

/** Keep APK/JAR resources that dex2jar itself does not emit. */
async function mergeDexResources(input: string, output: string): Promise<void> {
  const sourceEntries = zipEntries(await readFile(input)).filter(entry => isResourceEntry(entry.name))
  if (!sourceEntries.length) return
  const convertedEntries = zipEntries(await readFile(output))
  const names = new Set(convertedEntries.map(entry => entry.name))
  const merged = convertedEntries.concat(sourceEntries.filter(entry => !names.has(entry.name)))
  await atomicWrite(output, buildZip(merged))
}

async function convertDex(runtime: JavaRuntime, input: string, output: string): Promise<void> {
  if (!runtime.d2jLibraries.length) throw appError('type3_java_dex_tool_missing', 'Windows JVM Type3 缺少 dex2jar 工具', 503)
  const classpath = runtime.d2jLibraries.join(path.delimiter)
  const temporary = output + '.' + randomUUID() + '.tmp.jar'
  const result = await runBounded(runtime.java, [
    '-Xmx768m', '-Dfile.encoding=UTF-8', '-cp', classpath,
    'com.googlecode.dex2jar.tools.Dex2jarCmd', '--force', '--output', temporary, input
  ], { timeoutMs: DEX2JAR_TIMEOUT_MS, maxStdout: 512 * 1024, maxStderr: 2 * 1024 * 1024 })
  try {
    if (result.timedOut) throw appError('type3_java_dex_timeout', 'JVM Spider DEX 转换超时', 504)
    if (result.truncated || result.code !== 0) {
      const detail = result.stderr.trim().slice(-800)
      throw appError('type3_java_dex_convert_failed', 'JVM Spider DEX 转换失败' + (detail ? '：' + detail : ''), 422)
    }
    await stat(temporary)
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
    await rename(temporary, output)
    await mergeDexResources(input, output)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function argument(value: unknown, label: string, limit: number): string {
  if (value === undefined || value === null) return ''
  const result = String(value)
  if (result.length > limit) throw appError('type3_java_argument_too_large', `JVM Spider ${label} 参数过长`)
  return result
}

function extArgument(value: unknown): string {
  if (value === undefined || value === null) return ''
  const result = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof result !== 'string') throw appError('type3_java_ext_invalid', 'JVM Spider ext 无法序列化')
  // Windows CreateProcess has a finite command-line limit. The ext field is
  // normally a short JSON object; refuse oversized values instead of truncating.
  if (result.length > 24_000) throw appError('type3_java_ext_too_large', 'JVM Spider ext 超过 Windows 命令行长度限制')
  return result
}

function vipFlagsArgument(flags: unknown): string {
  if (!Array.isArray(flags)) return ''
  const values = flags.filter((flag): flag is string => typeof flag === 'string' && flag.length <= 512 && !/[\u0000-\u001f\u007f]/.test(flag)).slice(0, 100)
  if (!values.length) return ''
  return Buffer.from(values.join('\u001f'), 'utf8').toString('base64')
}

async function invokeRunner(runtime: JavaRuntime, jar: string, className: string, action: JavaInvokeAction, ext: string, args: JavaInvokeArgs, flags: unknown): Promise<string> {
  const classpath = [runtime.runnerClasspath, runtime.stubs, ...runtime.libraries, jar].join(path.delimiter)
  const cacheDir = path.join(dataRoot(), 'type3', 'java', 'host-cache')
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  const keyword = argument(args.keyword, 'keyword', 240)
  const page = argument(args.page === undefined ? 1 : args.page, 'page', 8)
  const id = argument(args.id, 'id', 4096)
  const flag = argument(args.flag, 'flag', 512)
  // java.exe converts Windows native argv through the process code page on
  // some hosts, even with -Dfile.encoding=UTF-8. Encode every variable value
  // as ASCII/Base64 and decode in our own runner before Spider invocation.
  const utf8Arg = (value: string) => 'netpan_utf8_base64:' + Buffer.from(value, 'utf8').toString('base64')
  const result = await runBounded(runtime.java, [
    '-noverify', '-Xmx512m', '-Dfile.encoding=UTF-8', '-Dtvbox.spiderCacheDir=' + cacheDir,
    '-cp', classpath, 'NetPanSpiderRunner', className, action,
    utf8Arg(ext), utf8Arg(keyword), utf8Arg(page), utf8Arg(id), utf8Arg(flag), utf8Arg(vipFlagsArgument(flags))
  ], { timeoutMs: JAVA_TIMEOUT_MS, maxStdout: MAX_JAVA_STDOUT, maxStderr: MAX_JAVA_STDERR })
  if (result.timedOut) throw appError('type3_java_timeout', 'JVM Spider 执行超时', 504)
  if (result.truncated) throw appError('type3_java_output_too_large', 'JVM Spider 输出超过安全上限', 422)
  if (result.code !== 0) {
    const detail = result.stderr.trim().slice(-1200)
    throw appError('type3_java_failed', 'JVM Spider 执行失败' + (detail ? '：' + detail : ''), 422)
  }
  const output = result.stdout.replace(/^\uFEFF/, '').trim()
  if (!output) throw appError('type3_java_empty', 'JVM Spider 没有返回结果，不能视为兼容成功', 422)
  try { JSON.parse(output) }
  catch { throw appError('type3_java_invalid_json', 'JVM Spider 返回的不是合法 JSON', 422) }
  return output
}

async function preparedSpider(runtime: JavaRuntime, spec: SpiderSpec): Promise<string> {
  const cached = await cacheSpider(spec)
  if (cached.info.hasNativeLibrary) {
    throw appError('type3_java_native_unsupported', '该 Spider 包含 Android 原生库（.so），Windows JVM 适配器已拒绝执行；需要原生 Android 兼容层', 422)
  }
  if (cached.info.kind === 'jar') return cached.file
  const output = cached.file + '.jvm.jar'
  if (!existsSync(output)) await convertDex(runtime, cached.file, output)
  return output
}

async function trustedArtifactPath(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const configuredRoot = String(process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT || '').trim()
  if (!configuredRoot) throw appError('type3_java_jar_override_disabled', 'JVM Spider 本地 JAR 覆盖未启用')
  let root: string
  let candidate: string
  try {
    root = await realpath(path.resolve(configuredRoot))
    candidate = await realpath(path.resolve(value))
  } catch {
    throw appError('type3_java_jar_override_invalid', 'JVM Spider 本地 JAR 不存在')
  }
  const relative = path.relative(root, candidate)
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
      !/\.(?:jar|dex)$/i.test(candidate)) {
    throw appError('type3_java_jar_override_invalid', 'JVM Spider 本地 JAR/DEX 不在受信目录内')
  }
  return candidate
}

async function preparedTrustedArtifact(runtime: JavaRuntime, artifact: string): Promise<string> {
  const bytes = await readFile(artifact)
  const info = inspectType3Archive(bytes)
  if (info.hasNativeLibrary) {
    throw appError('type3_java_native_unsupported', '该 Spider 包含 Android 原生库（.so），Windows JVM 适配器已拒绝执行；需要原生 Android 兼容层', 422)
  }
  if (info.kind === 'jar') return artifact
  const output = path.join(dataRoot(), 'type3', 'java', sha256(bytes) + '.trusted.jvm.jar')
  if (!existsSync(output)) await convertDex(runtime, artifact, output)
  return output
}

/**
 * Invoke a standard JVM-compatible CatVod/TVBox Spider. Android DEX is first
 * converted by the bundled dex-tools; Android native libraries are rejected
 * explicitly because loading ARM/Android JNI code in a Windows JVM is unsafe.
 */
export async function invokeJavaSource(source: JavaVideoSource, action: JavaInvokeAction, args: JavaInvokeArgs = {}): Promise<unknown> {
  if (!['home', 'search', 'detail', 'play'].includes(action)) throw appError('type3_java_action_invalid', 'JVM Spider 操作类型不支持')
  const runtime = await resolveRuntime()
  const className = classNameForApi(source.apiUrl)
  const override = await trustedArtifactPath(source.jarPath || source.trustedJarPath)
  const jar = override
    ? await preparedTrustedArtifact(runtime, override)
    : await preparedSpider(runtime, parseSpiderSpec(source.spider))
  const output = await invokeRunner(runtime, jar, className, action, extArgument(source.ext), args, source.flags)
  return JSON.parse(output) as unknown
}
