import type { DecisionBlackbox, DecisionModel } from './types'

const sealedModels = new WeakMap<object, DecisionModel>()

function createTrapError(operation: string) {
  return new Error(`DecisionModel blackbox does not allow ${operation}.`)
}

export function sealDecisionModel(model: DecisionModel): DecisionBlackbox {
  const target = Object.create(null)
  const proxy = new Proxy(target, {
    get(_target, property) {
      if (property === Symbol.toStringTag) return 'DecisionBlackbox'
      throw createTrapError(`property access (${String(property)})`)
    },
    has() {
      return false
    },
    ownKeys() {
      return []
    },
    getOwnPropertyDescriptor() {
      return undefined
    },
    set() {
      throw createTrapError('mutation')
    },
    defineProperty() {
      throw createTrapError('definition')
    },
    deleteProperty() {
      throw createTrapError('deletion')
    }
  })

  sealedModels.set(proxy, model)
  return Object.freeze(proxy) as DecisionBlackbox
}

export function readSealedDecisionModel(box: DecisionBlackbox): DecisionModel {
  const model = sealedModels.get(box as object)
  if (!model) throw createTrapError('untrusted read')
  return model
}
