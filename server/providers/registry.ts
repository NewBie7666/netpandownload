import type { ProviderDebugResult } from '../../shared/types.js'
import { AppError } from '../http.js'
import { quarkProvider } from './quarkProvider.js'
import type { Provider, ProviderId } from './types.js'

const providers: Provider[] = [quarkProvider]
let matchedInput: string | undefined
let lastResolveStatus: ProviderDebugResult['lastResolveStatus']

export function listProviders() {
  return [...providers]
}

export function getProvider(id: ProviderId) {
  const provider = providers.find((item) => item.id === id)
  if (!provider) {
    throw new AppError('unsupported_provider', '暂不支持该资源来源', 400)
  }
  return provider
}

export function findProviderByInput(input: string) {
  const provider = providers.find((item) => item.match(input))
  if (provider) {
    matchedInput = String(input || '').trim()
  }
  return provider
}

export function requireProviderForInput(input: string) {
  const provider = findProviderByInput(input)
  if (!provider) {
    lastResolveStatus = 'error'
    throw new AppError('unsupported_provider', '暂不支持该资源来源', 400)
  }
  return provider
}

export function recordProviderResolveStatus(status: ProviderDebugResult['lastResolveStatus']) {
  lastResolveStatus = status
}

export function getProviderDebug(): ProviderDebugResult {
  return {
    registered: providers.map((provider) => provider.id),
    matchedInput,
    lastResolveStatus
  }
}
