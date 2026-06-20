import type { DecisionBlackbox, DecisionViewModel } from './types'

const semanticKeyPattern = /(platform|risk|confidence|tool|status|feasible|feasibility|reason|decisionmodel|core|assessment|recommendation)/i
const semanticValuePattern = /(yt-dlp|aria2|idm|bilibili|quark|youtube|douyin|zhihu|instagram|\b\d+%|\bhigh\b|\bmedium\b|\blow\b)/i

function walk(value: unknown, visit: (key: string, current: unknown) => void, key = '') {
  visit(key, value)
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${key}[${index}]`))
    return
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    walk(childValue, visit, childKey)
  }
}

export function assertSemanticIntegrity(box: DecisionBlackbox) {
  const keys = Object.keys(box as object)
  if (keys.length) throw new Error('Decision blackbox exposed enumerable keys.')

  const spread = { ...(box as object) }
  if (Object.keys(spread).length) throw new Error('Decision blackbox can be spread.')

  try {
    JSON.stringify(box)
    throw new Error('Decision blackbox can be serialized.')
  } catch (error) {
    if (error instanceof Error && error.message === 'Decision blackbox can be serialized.') throw error
  }
}

export function assertViewPayloadIntegrity(view: DecisionViewModel) {
  walk(view, (key, current) => {
    if (key && semanticKeyPattern.test(key)) {
      throw new Error(`Strict view leaked semantic key: ${key}`)
    }
    if (typeof current === 'string' && semanticValuePattern.test(current)) {
      throw new Error(`Strict view leaked semantic value: ${current}`)
    }
  })
}
