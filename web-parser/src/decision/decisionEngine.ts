import type { WebParseResult } from '../../server/types'
import { applyCapabilityRules } from './capabilityRules'
import { computeConfidence } from './confidenceScorer'
import { detectPlatformFacts } from './platformDetector'
import { generateReasonCodes } from './reasonGenerator'
import { computeRisk } from './riskEngine'
import { buildRecommendation } from './toolRouter'
import type { DecisionAssessment, DecisionModel } from './types'

export function decisionEngine(result: WebParseResult): DecisionModel {
  const facts = detectPlatformFacts(result)
  const core = applyCapabilityRules(facts)
  const reasonCodes = generateReasonCodes(core, facts)

  const assessment: DecisionAssessment = {
    risk: computeRisk(core, reasonCodes),
    confidence: computeConfidence(core, reasonCodes),
    reasonCodes
  }

  return {
    core,
    assessment,
    recommendation: buildRecommendation(core, assessment)
  }
}
