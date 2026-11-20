import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { AppError } from '../../server/http.js'
import { classNameForApi, inspectType3Archive, invokeJavaSource } from '../../server/video-sources/type3-java.js'

const execFile = promisify(execFileCallback)

function little16(value: number): Buffer {
  const out = Buffer.alloc(2)
  out.writeUInt16LE(value, 0)
  return out
}

function little32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value >>> 0, 0)
  return out
}

function crc32(bytes: Buffer): number {
  let result = 0xffffffff
  for (const byte of bytes) {
    result ^= byte
    for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0)
  }
  return (result ^ 0xffffffff) >>> 0
}

function storedZip(entries: Record<string, Buffer>): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const localHeader = Buffer.concat([
      little32(0x04034b50), little16(20), little16(0x0800), little16(0), little16(0), little16(0),
      little32(crc), little32(data.length), little32(data.length), little16(nameBytes.length), little16(0), nameBytes
    ])
    local.push(localHeader, data)
    central.push(Buffer.concat([
      little32(0x02014b50), little16(20), little16(20), little16(0x0800), little16(0), little16(0), little16(0),
      little32(crc), little32(data.length), little32(data.length), little16(nameBytes.length), little16(0), little16(0),
      little16(0), little16(0), little32(0), little32(offset), nameBytes
    ]))
    offset += localHeader.length + data.length
  }
  const directory = Buffer.concat(central)
  return Buffer.concat([
    ...local, directory,
    little32(0x06054b50), little16(0), little16(0), little16(Object.keys(entries).length), little16(Object.keys(entries).length),
    little32(directory.length), little32(offset), little16(0)
  ])
}

function runtimeRootFromEnvironment(): string | undefined {
  const configured = String(process.env.NETPAN_TYPE3_JAVA_ROOT || '').trim()
  const roots = configured ? [configured] : [path.resolve('resources', 'type3', 'java')]
  for (const root of roots) {
    const java = path.join(root, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    const ecj = path.join(root, 'tools', 'ecj.jar')
    const stubs = path.join(root, 'stubs', 'stubs.jar')
    const runner = path.join(root, 'runner', 'NetPanSpiderRunner.class')
    if (existsSync(java) && existsSync(ecj) && existsSync(stubs) && existsSync(runner)) return root
  }
  return undefined
}

test('Type3 JVM helpers classify APIs and reject native Android payloads', () => {
  assert.equal(classNameForApi('csp_Fixture'), 'com.github.catvod.spider.Fixture')
  assert.equal(classNameForApi('com.example.CustomSpider'), 'com.example.CustomSpider')
  const jar = storedZip({ 'com/example/Spider.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe]) })
  assert.deepEqual(inspectType3Archive(jar), {
    kind: 'jar', entries: ['com/example/Spider.class'], hasNativeLibrary: false
  })
  const dex = storedZip({ 'classes.dex': Buffer.from('dex\n035\0'), 'lib/arm64-v8a/libguard.so': Buffer.from([1, 2, 3]) })
  const info = inspectType3Archive(dex)
  assert.equal(info.kind, 'dex')
  assert.equal(info.hasNativeLibrary, true)
})

test('Type3 JVM reports a missing packaged runtime instead of pretending import is compatibility', async () => {
  const oldRoot = process.env.NETPAN_TYPE3_JAVA_ROOT
  const oldResources = process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT
  process.env.NETPAN_TYPE3_JAVA_ROOT = path.join(tmpdir(), 'netpan-type3-runtime-does-not-exist')
  delete process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT
  try {
    await assert.rejects(
      () => invokeJavaSource({ id: 'missing', apiUrl: 'csp_Missing', jarPath: path.join(tmpdir(), 'missing.jar') }, 'home'),
      error => error instanceof AppError && error.error === 'type3_java_runtime_missing'
    )
  } finally {
    if (oldRoot === undefined) delete process.env.NETPAN_TYPE3_JAVA_ROOT
    else process.env.NETPAN_TYPE3_JAVA_ROOT = oldRoot
    if (oldResources === undefined) delete process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT
    else process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT = oldResources
  }
})

test('standard JVM class Spider completes real home/search/detail/play calls', async t => {
  const runtime = runtimeRootFromEnvironment()
  if (!runtime) {
    if (process.env.NETPAN_TYPE3_REQUIRE_RUNTIME === '1') {
      assert.fail('NETPAN_TYPE3_REQUIRE_RUNTIME=1 but resources/type3/java is not prepared')
    }
    t.skip('set NETPAN_TYPE3_JAVA_ROOT to a prepared runtime to run the real JVM fixture')
    return
  }
  const work = await mkdtemp(path.join(tmpdir(), 'netpan-type3-java-fixture-'))
  const oldRoot = process.env.NETPAN_TYPE3_JAVA_ROOT
  const oldTrusted = process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT
  const oldData = process.env.NETPAN_DATA_DIR
  process.env.NETPAN_TYPE3_JAVA_ROOT = runtime
  process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT = work
  process.env.NETPAN_DATA_DIR = work
  try {
    const sourceFile = path.join(work, 'FixtureSpider.java')
    await writeFile(sourceFile, `package com.github.catvod.spider;
import java.util.List;
public final class FixtureSpider {
  private String ext = "";
  public FixtureSpider() {}
  public void init(String value) { ext = value; }
  private String result(String action, String value) {
    return "{\\"action\\":\\"" + action + "\\",\\"value\\":\\"" + value + "\\",\\"ext\\":\\"" + ext + "\\"}";
  }
  public String homeContent(boolean filter) { return result("home", String.valueOf(filter)); }
  public String searchContent(String key, boolean quick, String page) { return result("search", key + "|" + page); }
  public String detailContent(List<String> ids) { return result("detail", ids.isEmpty() ? "" : ids.get(0)); }
  public String playerContent(String flag, String id, List<String> vip) { return result("play", flag + "|" + id + "|" + vip.size()); }
}` , 'utf8')
    const java = path.join(runtime, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    const ecj = path.join(runtime, 'tools', 'ecj.jar')
    const stubs = path.join(runtime, 'stubs', 'stubs.jar')
    const classes = path.join(work, 'classes')
    await execFile(java, ['-cp', ecj, 'org.eclipse.jdt.internal.compiler.batch.Main', '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', stubs, '-d', classes, sourceFile], { windowsHide: true })
    const classFile = await readFile(path.join(classes, 'com', 'github', 'catvod', 'spider', 'FixtureSpider.class'))
    const fixtureJar = path.join(work, 'fixture.jar')
    await writeFile(fixtureJar, storedZip({ 'com/github/catvod/spider/FixtureSpider.class': classFile }))

    const source = { id: 'fixture', apiUrl: 'csp_FixtureSpider', ext: 'fixture-ext', flags: ['含中文', 'vip-2'], jarPath: fixtureJar }
    assert.deepEqual(await invokeJavaSource(source, 'home'), { action: 'home', value: 'true', ext: 'fixture-ext' })
    assert.deepEqual(await invokeJavaSource(source, 'search', { keyword: '猫', page: 2 }), { action: 'search', value: '猫|2', ext: 'fixture-ext' })
    assert.deepEqual(await invokeJavaSource(source, 'detail', { id: 'movie-1' }), { action: 'detail', value: 'movie-1', ext: 'fixture-ext' })
    assert.deepEqual(await invokeJavaSource(source, 'play', { id: 'episode-1', flag: 'line-a' }), { action: 'play', value: 'line-a|episode-1|2', ext: 'fixture-ext' })

    const dexFile = path.join(work, 'fixture.dex')
    const dx = path.join(runtime, 'd2j', 'dx-30.0.2.jar')
    await execFile(java, ['-cp', dx, 'com.android.dx.command.Main', '--dex', '--output=' + dexFile, classes], { windowsHide: true })
    assert.equal((await readFile(dexFile)).subarray(0, 4).toString('ascii'), 'dex\n')
    const dexSource = { ...source, jarPath: dexFile }
    assert.deepEqual(await invokeJavaSource(dexSource, 'search', { keyword: '猫', page: 2 }), { action: 'search', value: '猫|2', ext: 'fixture-ext' })
    assert.deepEqual(await invokeJavaSource(dexSource, 'detail', { id: 'movie-1' }), { action: 'detail', value: 'movie-1', ext: 'fixture-ext' })
    assert.deepEqual(await invokeJavaSource(dexSource, 'play', { id: 'episode-1', flag: 'line-a' }), { action: 'play', value: 'line-a|episode-1|2', ext: 'fixture-ext' })
  } finally {
    if (oldRoot === undefined) delete process.env.NETPAN_TYPE3_JAVA_ROOT
    else process.env.NETPAN_TYPE3_JAVA_ROOT = oldRoot
    if (oldTrusted === undefined) delete process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT
    else process.env.NETPAN_TYPE3_TRUSTED_JAR_ROOT = oldTrusted
    if (oldData === undefined) delete process.env.NETPAN_DATA_DIR
    else process.env.NETPAN_DATA_DIR = oldData
    await rm(work, { recursive: true, force: true })
  }
})
