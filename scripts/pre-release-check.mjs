import { spawnSync } from 'node:child_process'

const commands = [
  ['npm', ['run', 'build'], 'build success and TypeScript server/client check'],
  ['npm', ['run', 'build:electron'], 'Electron TypeScript check'],
  ['node', ['scripts/release/buildDeterminismCheck.mjs'], 'Build determinism check'],
  ['npx', ['tsx', 'server/providers/bilibili/resolver/resolver.test.ts'], 'Bilibili resolver regression test'],
  ['npx', ['tsx', 'tests/release/failureRegression.test.ts'], 'Release failure regression test'],
  ['npx', ['tsx', 'tests/release/contractRegression.test.ts'], 'Release contract regression test'],
  ['npx', ['tsx', 'scripts/stability/runLongSession.ts', '--mock'], 'Long-run stability mock test'],
  ['node', ['scripts/release/freeze-check.mjs'], 'RC freeze contract check']
]

function run(command, args, label) {
  console.log(`[pre-release-check] ${label}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  if (result.status !== 0) {
    process.exitCode = result.status || 1
    throw new Error(`${label} failed`)
  }
}

for (const [command, args, label] of commands) {
  run(command, args, label)
}

console.log('[pre-release-check] unresolved imports are covered by TypeScript checks')
console.log('[pre-release-check] release gate passed')
