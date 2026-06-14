import { Router } from 'express'
import { AppError, ok } from '../http.js'
import {
  findProviderByInput,
  getProvider,
  getProviderDebug,
  requireProviderForInput
} from '../providers/registry.js'
import {
  providerCapabilityError,
  toAppError,
  toInternalExecutionContract,
  type InternalExecutionContract
} from '../providers/providerResponse.js'
import type { DownloadResult, ListResult, ShareResult } from '../../shared/types.js'
import type { Provider, ProviderId, ProviderResponse } from '../providers/types.js'

export const providersRouter = Router()

function requireContractData<T>(contract: InternalExecutionContract<T>) {
  if (!contract.ok || contract.kind !== 'success') {
    throw toAppError(
      contract.error || {
        code: 'parse_failed',
        message: 'Provider 处理失败',
        recoverable: true
      }
    )
  }
  if (!contract.data) {
    throw new AppError('parse_failed', 'Provider 未返回数据', 502)
  }
  return contract.data
}

function toPublicMeta<T>(contract: InternalExecutionContract<T>) {
  return {
    source: contract.meta.runtime.source,
    executable: contract.meta.runtime.executable,
    traceId: contract.meta.runtime.traceId,
    durationMs: contract.meta.runtime.durationMs,
    reason: contract.meta.provider.reason
  }
}

function wrapResponse<T>(
  provider: Provider,
  operation: 'resolve' | 'list' | 'download' | 'debug',
  response: ProviderResponse<T>,
  startedAt: number
) {
  return toInternalExecutionContract(response, operation, startedAt)
}

providersRouter.post('/resolve', async (req, res, next) => {
  const startedAt = Date.now()
  try {
    const provider = requireProviderForInput(req.body?.input)
    const contract = wrapResponse<ShareResult>(
      provider,
      'resolve',
      await provider.resolveShare({
        shareUrl: req.body?.input,
        passcode: req.body?.passcode
      }),
      startedAt
    )
    const share = requireContractData(contract)
    res.json(ok({ providerId: provider.id, share, meta: toPublicMeta(contract) }))
  } catch (error) {
    next(error)
  }
})

providersRouter.post('/list', async (req, res, next) => {
  const startedAt = Date.now()
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const response = provider.capabilities.list
      ? await provider.list({
          shareId: String(req.body?.shareId || ''),
          stoken: String(req.body?.stoken || ''),
          dirFid: req.body?.dirFid
        })
      : providerCapabilityError<ListResult>(provider.id, 'list')
    const contract = wrapResponse<ListResult>(provider, 'list', response, startedAt)
    const list = requireContractData(contract)
    res.json(ok({ providerId: provider.id, list, meta: toPublicMeta(contract) }))
  } catch (error) {
    next(error)
  }
})

providersRouter.post('/download', async (req, res, next) => {
  const startedAt = Date.now()
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const response = provider.capabilities.download
      ? await provider.getDownload({
          shareId: String(req.body?.shareId || ''),
          stoken: String(req.body?.stoken || ''),
          file: req.body?.file,
          sessionId: req.body?.sessionId
        })
      : providerCapabilityError<DownloadResult>(provider.id, 'download')
    const contract = wrapResponse<DownloadResult>(provider, 'download', response, startedAt)
    const download = requireContractData(contract)
    res.json(ok({ providerId: provider.id, download, meta: toPublicMeta(contract) }))
  } catch (error) {
    next(error)
  }
})

providersRouter.get('/debug', (req, res) => {
  const input = typeof req.query.input === 'string' ? req.query.input : ''
  if (input) {
    findProviderByInput(input)
  }
  res.json(ok(getProviderDebug()))
})

providersRouter.post('/debug/resolve', async (req, res, next) => {
  const startedAt = Date.now()
  try {
    const provider = requireProviderForInput(req.body?.input)
    const response = await provider.resolveShare({
      shareUrl: req.body?.input,
      passcode: req.body?.passcode
    })
    res.json(ok(wrapResponse(provider, 'debug', response, startedAt)))
  } catch (error) {
    next(error)
  }
})

providersRouter.post('/debug/list', async (req, res, next) => {
  const startedAt = Date.now()
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const response = provider.capabilities.list
      ? await provider.list({
          shareId: req.body?.shareId,
          stoken: req.body?.stoken,
          dirFid: req.body?.dirFid
        })
      : providerCapabilityError<ListResult>(provider.id, 'list')
    res.json(ok(wrapResponse(provider, 'debug', response, startedAt)))
  } catch (error) {
    next(error)
  }
})

providersRouter.post('/debug/download', async (req, res, next) => {
  const startedAt = Date.now()
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const response = provider.capabilities.download
      ? await provider.getDownload({
          shareId: req.body?.shareId,
          stoken: req.body?.stoken,
          file: req.body?.file,
          sessionId: req.body?.sessionId
        })
      : providerCapabilityError<DownloadResult>(provider.id, 'download')
    res.json(ok(wrapResponse(provider, 'debug', response, startedAt)))
  } catch (error) {
    next(error)
  }
})
