import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const releaseDir = join(root, 'release')
const minExeBytes = 1024 * 1024

function fail(message) {
  throw new Error(`[artifact-integrity] ${message}`)
}

function containsFile(dir) {
  if (!existsSync(dir)) return false
  return readdirSync(dir, { withFileTypes: true }).some(entry =>
    entry.isFile() || (entry.isDirectory() && containsFile(join(dir, entry.name)))
  )
}

for (const dir of ['dist', 'dist-server', 'dist-electron']) {
  if (!containsFile(join(root, dir))) fail(`missing or empty build directory: ${dir}`)
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const exe = join(releaseDir, `NetPanDownload-${version}-windows-x64.exe`)
if (!existsSync(exe)) fail(`missing portable executable: ${relative(root, exe)}`)
const size = statSync(exe).size
if (size < minExeBytes) fail(`exe is unexpectedly small: ${relative(root, exe)} (${size} bytes)`)

const unpackedResources = join(releaseDir, 'win-unpacked', 'resources')
for (const binary of ['aria2/win/aria2c.exe', 'yt-dlp/win/yt-dlp.exe', 'ffmpeg/win/ffmpeg.exe', 'ffmpeg/win/ffprobe.exe',
  'type3/java/jre/bin/java.exe', 'type3/java/stubs/stubs.jar', 'type3/java/runner/NetPanSpiderRunner.class']) {
  const packaged = join(unpackedResources, binary)
  if (!existsSync(packaged) || !statSync(packaged).isFile() || statSync(packaged).size === 0) {
    fail(`missing bundled executable: ${relative(root, packaged)}`)
  }
}
if (!containsFile(join(unpackedResources, 'ffmpeg', 'licenses'))) {
  fail('missing bundled FFmpeg license notices')
}
for (const directory of ['type3/java/libs', 'type3/java/d2j']) {
  if (!containsFile(join(unpackedResources, directory))) fail('missing Type3 JVM dependencies: ' + directory)
}
if (!existsSync(join(unpackedResources, 'type3/java/WinBox-LICENSE.txt'))) fail('missing Type3 stub license notice')

console.log(`[artifact-integrity] ${relative(root, exe)} passed bundled runtime checks`)
