import { rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = path.resolve(root, 'dist-public')
if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== 'dist-public') throw new Error('Invalid output path')
await rm(output, { recursive: true, force: true })
function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules', script), ...args], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
run('vue-tsc/bin/vue-tsc.js', ['-p', 'public-search/tsconfig.client.json', '--noEmit'])
run('vite/bin/vite.js', ['build', '--config', 'public-search/vite.config.ts'])
run('typescript/bin/tsc', ['-p', 'public-search/tsconfig.server.json'])
const allowed = /^(?:public-search\/server\/(?:index|app|network|search)|server\/search-core\/(?:codeSearch|keywordSearch|generalSearch)|server\/http|shared\/types)\.js$/
async function verify(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) await verify(path.join(dir, entry.name), name + '/')
    else if (!allowed.test(name)) throw new Error('Forbidden public runtime module: ' + name)
  }
}
await verify(path.join(output, 'server'))
console.info('Public build verified: search modules only; no local downloader, auth, settings or task modules.')
