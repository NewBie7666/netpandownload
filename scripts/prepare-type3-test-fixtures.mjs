import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

// Developer-only, self-written live NASA fixtures; no third-party source is bundled.
const runtime = path.resolve(process.env.NETPAN_TYPE3_JAVA_ROOT || 'resources/type3/java')
const work = await mkdtemp(path.join(tmpdir(), 'netpan-nasa-fixture-'))
const java = path.join(runtime, 'jre/bin', process.platform === 'win32' ? 'java.exe' : 'java')
const libraries = (await readdir(path.join(runtime, 'libs'))).filter(n => n.endsWith('.jar')).map(n => path.join(runtime, 'libs', n))
const classes = path.join(work, 'classes')
execFileSync(java, ['-cp', path.join(runtime, 'tools/ecj.jar'), 'org.eclipse.jdt.internal.compiler.batch.Main',
  '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', [path.join(runtime, 'stubs/stubs.jar'), ...libraries].join(path.delimiter),
  '-d', classes, path.resolve('tests/fixtures/type3/Nasa.java')], { windowsHide: true, stdio: 'inherit' })
const classFile = await readFile(path.join(classes, 'com/github/catvod/spider/Nasa.class'))
const compressed = deflateRawSync(classFile)
let crc = 0xffffffff
for (const byte of classFile) {
  crc ^= byte
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
}
crc = (crc ^ 0xffffffff) >>> 0
const name = Buffer.from('com/github/catvod/spider/Nasa.class')
const local = Buffer.alloc(30)
local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(classFile.length, 22); local.writeUInt16LE(name.length, 26)
const central = Buffer.alloc(46)
central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(classFile.length, 24); central.writeUInt16LE(name.length, 28)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16)
await writeFile(path.join(work, 'nasa.jar'), Buffer.concat([local, name, compressed, central, name, end]))
execFileSync(java, ['-cp', path.join(runtime, 'd2j/dx-30.0.2.jar'), 'com.android.dx.command.Main', '--dex',
  '--output=' + path.join(work, 'nasa.dex'), classes], { windowsHide: true, stdio: 'inherit' })
console.log(JSON.stringify({ NETPAN_TYPE3_TRUSTED_JAR_ROOT: work, NETPAN_QA_JVM_JAR: path.join(work, 'nasa.jar'),
  NETPAN_QA_DEX_JAR: path.join(work, 'nasa.dex') }, null, 2))
