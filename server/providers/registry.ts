import { AppError } from '../http.js'
import { bilibiliProvider } from './bilibiliProvider.js'
import { getLastExecutionTrace } from './executionTrace.js'
import { quarkProvider } from './quarkProvider.js'
import type { Provider, ProviderId } from './types.js'

const providers: Provider[] = [quarkProvider, bilibiliProvider]
let matchedProvider: string | undefined

export function listProviders() {
  return [...providers]
}

export function getProvider(id: ProviderId) {
  const provider = providers.find((item) => item.id === id)
  if (!provider) {
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
    throw new AppError('unsupported_provider', '暂不支持该资源来源', 400)
  }
  return provider
}

export function getProviderDebug() {
  const trace = getLastExecutionTrace()
  return {
    registered: providers.map((provider) => provider.id),
    matchedProvider,
    lastResult: trace
      ? {
          kind: trace.kind,
          status: trace.status,
          errorCode: trace.errorCode,
          traceId: trace.traceId,
          source: trace.source,
          executable: trace.executable
        }
      : undefined
  }
}
