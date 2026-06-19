import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const releaseDir = join(root, 'release')
const minExeBytes = 1024 * 1024

function fail(message) {
  throw new Error(`[artifact-integrity] ${message}`)
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, files)
    else if (stat.isFile()) files.push(full)
  }
  return files
}

for (const dir of ['dist', 'dist-server', 'dist-electron']) {
  const full = join(root, dir)
  if (!existsSync(full)) fail(`missing build directory ${dir}`)
  if (!walk(full).length) fail(`empty build directory ${dir}`)
}

if (!existsSync(releaseDir)) fail('missing release directory')

const exeFiles = readdirSync(releaseDir)
  .map((name) => join(releaseDir, name))
  .filter((file) => statSync(file).isFile() && file.toLowerCase().endsWith('.exe'))
if (!exeFiles.length) fail('no portable exe found in release directory')

for (const exe of exeFiles) {
  const size = statSync(exe).size
  if (size < minExeBytes) {
    fail(`exe is unexpectedly small: ${relative(root, exe)} (${size} bytes)`)
  }
}

const unpackedResources = join(releaseDir, 'win-unpacked', 'resources')
if (existsSync(unpackedResources)) {
  for (const resourceName of ['aria2', 'yt-dlp']) {
    const source = join(root, 'resources', resourceName)
    const target = join(unpackedResources, resourceName)
    if (existsSync(source) && walk(source).length && !existsSync(target)) {
      fail(`resource exists in source but is missing from artifact: ${resourceName}`)
    }
  }
}

console.log(`[artifact-integrity] release contains ${exeFiles.length} exe artifact(s)`)
console.log('[artifact-integrity] artifact integrity passed')
