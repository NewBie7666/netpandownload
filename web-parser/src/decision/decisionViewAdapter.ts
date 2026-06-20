import type { DecisionViewModel, StrictDecisionPresentation } from './types'

/**
 * VIEW ADAPTER RULES:
 *
 * - NO semantic reads
 * - NO branching by source, score, risk, or tool
 * - NO command or deep-link generation
 *
 * ONLY:
 * - pass-through presentation formatting
 */
export function toDecisionViewModel(presentation: StrictDecisionPresentation): DecisionViewModel {
  return {
    textBlocks: presentation.textBlocks,
    badges: presentation.badges,
    visualTokens: presentation.visualTokens,
    sections: presentation.sections,
    buttons: presentation.buttons
  }
}
