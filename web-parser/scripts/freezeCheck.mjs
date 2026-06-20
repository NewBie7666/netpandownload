import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function fail(message) {
  failures.push(message)
}

function assertNotContains(label, content, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(content)) fail(`${label} violates freeze rule: ${pattern}`)
  }
}

function listFiles(dir) {
  const fullDir = join(root, dir)
  return readdirSync(fullDir).flatMap((name) => {
    const fullPath = join(fullDir, name)
    const relativePath = `${dir}/${name}`.replace(/\\/g, '/')
    if (statSync(fullPath).isDirectory()) return listFiles(relativePath)
    return relativePath
  })
}

const appVue = read('src/App.vue')
assertNotContains('App.vue', appVue, [
  /\bproviderId\b/,
  /\burlType\b/,
  /\breasonCodes\b/,
  /\brecommendedTool\b/,
  /\bDecisionModel\b/,
  /\bdecisionEngine\(.*\)\.(core|assessment|recommendation)\b/,
  /\bif\s*\([^)]*decisionView\b/,
  /\bswitch\s*\([^)]*decisionView\b/
])

const viewAdapter = read('src/decision/decisionViewAdapter.ts')
assertNotContains('decisionViewAdapter', viewAdapter, [
  /from ['"]\.\/(platformDetector|capabilityRules|reasonGenerator|riskEngine|confidenceScorer|toolRouter|decisionEngine)['"]/,
  /model\.core\.platform\s*===/,
  /model\.core\.status\s*===/,
  /model\.assessment\.risk\s*===/,
  /compute[A-Z]/,
  /detect[A-Z]/,
  /apply[A-Z]/,
  /generate[A-Z]/,
  /buildRecommendation/
])

const decisionFiles = listFiles('src/decision')
for (const file of decisionFiles) {
  const content = read(file)
  assertNotContains(file, content, [
    /\bfetch\s*\(/,
    /\baxios\b/,
    /\bXMLHttpRequest\b/,
    /\bwindow\b/,
    /\bdocument\b/,
    /\bnavigator\b/,
    /from ['"].*\.(vue)['"]/,
    /from ['"]vue['"]/
  ])
}

const serverFiles = listFiles('server')
for (const file of serverFiles) {
  const content = read(file)
  assertNotContains(file, content, [
    /resolveMedia/,
    /ytDlpMedia/,
    /registerAllowedDownloadResult/,
    /addDownloadTask/,
    /aria2/i,
    /downloadUrl/,
    /proxyUrl/,
    /downloadToken/
  ])
}

if (failures.length) {
  console.error('Decision Engine freeze check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Decision Engine freeze check passed.')
