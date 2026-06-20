import type { WebParseResult } from '../../server/types'
import { sealDecisionModel } from './blackbox'
import { decisionEngine } from './decisionEngine'
import { toDecisionViewModel } from './decisionViewAdapter'
import { assertSemanticIntegrity, assertViewPayloadIntegrity } from './semanticBoundary'
import { projectStrictDecisionView } from './strictProjection'
import type { DecisionViewModel } from './types'

export function buildDecisionView(result: WebParseResult): DecisionViewModel {
  const box = sealDecisionModel(decisionEngine(result))
  assertSemanticIntegrity(box)
  const view = toDecisionViewModel(projectStrictDecisionView(box))
  assertViewPayloadIntegrity(view)
  return view
}
