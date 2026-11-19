import { mkdir, cp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const staging = path.resolve(root, 'release/public-search-staging')
const archive = path.resolve(root, 'release/netpandownload-public-search.zip')
if (path.dirname(staging) !== path.resolve(root, 'release')) throw new Error('Invalid staging directory')
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
// Explicit inputs: never copy the repository, .env, data, resources, local dist or node_modules.
await cp(path.join(root, 'dist-public'), path.join(staging, 'dist-public'), { recursive: true })
for (const name of ['nginx-public-search.conf.in', 'public-search.env.example', 'systemd/netpan-public-search.service']) {
  await mkdir(path.dirname(path.join(staging, 'deploy', name)), { recursive: true })
  await cp(path.join(root, 'public-search/deploy', name), path.join(staging, 'deploy', name))
}
for (const name of ['package.json', 'package-lock.json']) await cp(path.join(root, 'public-search/runtime', name), path.join(staging, name))
await cp(path.join(root, 'docs/PUBLIC_SEARCH_DEPLOY.md'), path.join(staging, 'PUBLIC_SEARCH_DEPLOY.md'))
const files = []
async function walk(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + '/')
    else files.push({ path: name, sha256: createHash('sha256').update(await readFile(path.join(dir, entry.name))).digest('hex') })
  }
}
await walk(staging)
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
await writeFile(path.join(staging, 'BUILD_MANIFEST.json'), JSON.stringify({ baseRevision: revision, builtAt: new Date().toISOString(), variant: 'public-search', files }, null, 2) + '\n')
// Python's stdlib creates a portable ZIP with relative slash-separated paths on Windows/Linux.
const code = 'import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(root).as_posix()) for p in sorted(root.rglob("*")) if p.is_file()]; z.close()'
const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, staging, archive], { stdio: 'inherit' })
if (result.status !== 0) throw new Error('ZIP creation failed; Python 3 is required for packaging only')
await writeFile(archive + '.sha256', createHash('sha256').update(await readFile(archive)).digest('hex') + '  ' + path.basename(archive) + '\n')
console.info('Public release: ' + archive)
