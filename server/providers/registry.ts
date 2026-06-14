import { AppError } from '../http.js'
import { bilibiliProvider } from './bilibiliProvider.js'
import { quarkProvider } from './quarkProvider.js'
import type { Provider, ProviderErrorCode, ProviderId, ProviderResponse } from './types.js'

interface ProviderDebugResult {
  registered: string[]
  matchedProvider?: string
  lastResult?: {
    status: 'ok' | 'error'
    errorCode?: ProviderErrorCode
  }
}

const providers: Provider[] = [quarkProvider, bilibiliProvider]
let matchedProvider: string | undefined
let lastResult: ProviderDebugResult['lastResult']

export function listProviders() {
  return [...providers]
}

export function getProvider(id: ProviderId) {
  const provider = providers.find((item) => item.id === id)
  if (!provider) {
    lastResult = { status: 'error', errorCode: 'unsupported_provider' }
    throw new AppError('unsupported_provider', '暂不支持该资源来源', 400)
  }
  matchedProvider = provider.id
  return provider
}

export function findProviderByInput(input: string) {
  const provider = providers.find((item) => item.match(input))
  if (provider) {
    matchedProvider = provider.id
  }
  return provider
}

export function requireProviderForInput(input: string) {
  const provider = findProviderByInput(input)
  if (!provider) {
    lastResult = { status: 'error', errorCode: 'unsupported_provider' }
    throw new AppError('unsupported_provider', '暂不支持该资源来源', 400)
  }
  return provider
}

export function recordProviderResult(response: ProviderResponse<unknown>) {
  lastResult = {
    status: response.status,
    errorCode: response.error?.code
  }
}

export function recordProviderException(error: unknown) {
  if (error instanceof AppError && error.error === 'unsupported_provider') {
    lastResult = { status: 'error', errorCode: 'unsupported_provider' }
    return
  }
  lastResult = { status: 'error', errorCode: 'parse_failed' }
}

export function getProviderDebug(): ProviderDebugResult {
  return {
    registered: providers.map((provider) => provider.id),
    matchedProvider,
    lastResult
  }
}
