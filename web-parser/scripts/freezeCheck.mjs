import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function fail(message) {
  failures.push(message)
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

function scriptFromVue(content) {
  return content.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? ''
}

function sourceFile(label, content) {
  return ts.createSourceFile(label, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function assertNoPatterns(label, content, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(content)) fail(`${label} violates semantic closure: ${pattern}`)
  }
}

function assertOnlyDecisionFacadeImports(label, content) {
  const source = sourceFile(label, content)
  walk(source, (node) => {
    if (!ts.isImportDeclaration(node)) return
    const specifier = node.moduleSpecifier.getText(source).replace(/['"]/g, '')
    if (specifier.startsWith('./decision/') || specifier.startsWith('../decision/')) {
      fail(`${label} imports internal decision module: ${specifier}`)
    }
    if (specifier === './decision') return
    if (specifier.includes('/decision')) fail(`${label} imports decision module outside facade: ${specifier}`)
  })
}

function assertNoPropertyAccess(label, content, properties) {
  const source = sourceFile(label, content)
  walk(source, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return
    const name = node.name.text
    if (properties.includes(name)) fail(`${label} reads forbidden property: .${name}`)
  })
}

function assertNoProxyEscape(label, content) {
  const source = sourceFile(label, content)
  walk(source, (node) => {
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) fail(`${label} uses spread on a value`)
    if (ts.isForInStatement(node)) fail(`${label} uses for-in inspection`)
    if (!ts.isCallExpression(node)) return
    const text = node.expression.getText(source)
    if (['JSON.stringify', 'Object.keys', 'Object.entries', 'Object.values', 'structuredClone'].includes(text)) {
      fail(`${label} uses proxy escape call: ${text}`)
    }
  })
}

function assertNoDestructure(label, content, forbiddenNames) {
  const source = sourceFile(label, content)
  walk(source, (node) => {
    if (!ts.isObjectBindingPattern(node)) return
    for (const element of node.elements) {
      const name = element.name.getText(source)
      if (forbiddenNames.includes(name)) fail(`${label} destructures semantic field: ${name}`)
    }
  })
}

const semanticProperties = [
  'core',
  'assessment',
  'recommendation',
  'risk',
  'confidence',
  'tool',
  'tools',
  'platform',
  'status',
  'feasible',
  'feasibility',
  'reason',
  'reasonCodes',
  'recommendedTool'
]

const appVue = read('src/App.vue')
const appScript = scriptFromVue(appVue)
assertOnlyDecisionFacadeImports('App.vue', appScript)
assertNoPropertyAccess('App.vue', appScript, semanticProperties)
assertNoDestructure('App.vue', appScript, semanticProperties)
assertNoProxyEscape('App.vue', appScript)
assertNoPatterns('App.vue', appVue, [
  /\bDecisionModel\b/,
  /\bDecisionCore\b/,
  /\bDecisionAssessment\b/,
  /\bDecisionRecommendation\b/,
  /decisionView\.(risk|confidence|tool|tools|feasible|platform|status|reason|reasonCodes|recommendedTool)\b/,
  /\bif\s*\([^)]*decisionView\b/,
  /\bswitch\s*\([^)]*decisionView\b/
])

const indexFile = read('src/decision/index.ts')
assertNoPatterns('decision facade exports', indexFile, [
  /decisionEngine/,
  /DecisionModel/,
  /DecisionCore/,
  /DecisionAssessment/,
  /DecisionRecommendation/,
  /DecisionBlackbox/,
  /sealDecisionModel/,
  /readSealedDecisionModel/
])
if (!/buildDecisionView\.strict/.test(indexFile)) fail('decision facade must export the strict builder')
if (!/executeOpaqueAction/.test(indexFile)) fail('decision facade must export opaque action executor')

const viewAdapter = read('src/decision/decisionViewAdapter.ts')
assertNoPatterns('decisionViewAdapter', viewAdapter, [
  /from ['"]\.\/(platformDetector|capabilityRules|reasonGenerator|riskEngine|confidenceScorer|toolRouter|decisionEngine|blackbox|strictProjection)['"]/,
  /\bif\s*\(/,
  /\bswitch\s*\(/,
  /netpan:\/\/action\?type=download/,
  /yt-dlp/,
  /aria2/,
  /bilibili/,
  /quark/
])
assertNoPropertyAccess('decisionViewAdapter', viewAdapter, semanticProperties)
assertNoProxyEscape('decisionViewAdapter', viewAdapter)

const strictProjection = read('src/decision/strictProjection.ts')
assertNoPatterns('strictProjection public leakage', strictProjection, [
  /yt-dlp/,
  /aria2/,
  /bilibili/,
  /quark/,
  /\b\d+%/,
  /\bhigh\b/,
  /\bmedium\b/,
  /\blow\b/
])

const blackbox = read('src/decision/blackbox.ts')
assertNoPatterns('blackbox hard seal', blackbox, [
  /Object\.assign/,
  /JSON\.stringify/
])
if (!/Proxy/.test(blackbox)) fail('blackbox must use a Proxy hard seal')
if (!/ownKeys\(\)/.test(blackbox)) fail('blackbox must trap enumeration')
if (!/getOwnPropertyDescriptor\(\)/.test(blackbox)) fail('blackbox must trap property descriptors')

const decisionEngine = read('src/decision/decisionEngine.ts')
if (!/DECISION_ENGINE_VERSION\s*=\s*['"]v1-frozen['"]/.test(decisionEngine)) fail('decisionEngine version marker is missing')
if (!/decisionEngine\(result:\s*WebParseResult\):\s*DecisionModel/.test(decisionEngine)) fail('decisionEngine contract signature changed')

const decisionFiles = listFiles('src/decision')
for (const file of decisionFiles) {
  const content = read(file)
  assertNoPatterns(file, content, [
    /\bfetch\s*\(/,
    /\baxios\b/,
    /\bXMLHttpRequest\b/,
    /from ['"].*\.(vue)['"]/,
    /from ['"]vue['"]/
  ])
}

const serverFiles = listFiles('server')
for (const file of serverFiles) {
  const content = read(file)
  assertNoPatterns(file, content, [
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
  console.error('Decision Engine semantic closure check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Decision Engine semantic closure check passed.')
