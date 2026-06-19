import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const outputDirs = ['dist', 'dist-server', 'dist-electron']
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json'])
const inputEnvKeys = [
  'NODE_ENV',
  'QUARK_MOCK',
  'YTDLP_PATH',
  'BILIBILI_COOKIE',
  'NETPAN_DATA_DIR',
  'ELECTRON_RENDERER_URL'
]

function hashBuffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readOptional(path) {
  const full = join(root, path)
  return existsSync(full) ? readFileSync(full) : Buffer.from('')
}

function npmVersion() {
  const result = spawnSync('npm', ['--version'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) return 'unknown'
  return result.stdout.trim()
}

function buildInputSnapshot() {
  const env = Object.fromEntries(inputEnvKeys.map((key) => [key, process.env[key] || '']))
  const snapshot = {
    node: process.version,
    npm: npmVersion(),
    platform: process.platform,
    arch: process.arch,
    packageJson: hashBuffer(readOptional('package.json')),
    packageLock: hashBuffer(readOptional('package-lock.json')),
    env
  }
  return {
    snapshot,
    hash: hashBuffer(JSON.stringify(snapshot))
  }
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, files)
    } else if (stat.isFile()) {
      files.push(full)
    }
  }
  return files
}

function normalizeFileContent(file) {
  return readFileSync(file)
}

function snapshotOutputs() {
  const entries = []
  for (const dir of outputDirs) {
    const fullDir = join(root, dir)
    if (!existsSync(fullDir)) {
      throw new Error(`[determinism] Missing build output directory: ${dir}`)
    }
    for (const file of walk(fullDir)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      entries.push(`${rel}:${hashBuffer(normalizeFileContent(file))}`)
    }
  }
  entries.sort()
  return hashBuffer(entries.join('\n'))
}

function run(command, args, label) {
  console.log(`[determinism] ${label}`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    throw new Error(`[determinism] ${label} failed`)
  }
}

const forbiddenPatterns = [
  { pattern: /localhost:5173|127\.0\.0\.1:5173/i, label: 'dev server URL' },
  { pattern: /NODE_ENV["']?\s*[:=]\s*["']development["']/i, label: 'development NODE_ENV marker' },
  { pattern: /VITE_DEV|__DEV__\s*=\s*true|import\.meta\.env\.DEV/i, label: 'dev-only flag' },
  { pattern: /BUILD_TIMESTAMP|BUILD_TIME|BUILD_DATE|__BUILD_RANDOM__|__BUILD_ID__/i, label: 'build timestamp/random marker' }
]

function scanProductionBundle() {
  for (const dir of outputDirs) {
    for (const file of walk(join(root, dir))) {
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
      if (!textExtensions.has(ext)) continue
      const content = readFileSync(file, 'utf8')
      for (const { pattern, label } of forbiddenPatterns) {
        if (pattern.test(content)) {
          throw new Error(`[determinism] Forbidden ${label} found in ${relative(root, file)}`)
        }
      }
    }
  }
}

const beforeInput = buildInputSnapshot()
const beforeOutput = snapshotOutputs()
run('npm', ['run', 'build'], 'repeat application build')
run('npm', ['run', 'build:electron'], 'repeat Electron build')
const afterInput = buildInputSnapshot()
const afterOutput = snapshotOutputs()

if (beforeInput.hash !== afterInput.hash) {
  throw new Error('[determinism] Build input snapshot changed during determinism check')
}

if (beforeOutput !== afterOutput) {
  throw new Error('[determinism] Repeated builds produced different output hashes')
}

scanProductionBundle()
console.log(`[determinism] input snapshot ${beforeInput.hash}`)
console.log('[determinism] build outputs are deterministic')
