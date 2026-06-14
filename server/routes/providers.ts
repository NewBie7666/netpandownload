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
  toApiResponse,
  toAppError,
  type ProviderApiEnvelope
} from '../providers/providerResponse.js'
import type { DownloadResult, ListResult, ShareResult } from '../../shared/types.js'
import type { Provider, ProviderId, ProviderResponse } from '../providers/types.js'

export const providersRouter = Router()

function requireEnvelopeData<T>(envelope: ProviderApiEnvelope<T>) {
  if (!envelope.ok) {
    throw toAppError(
      envelope.error || {
        code: 'parse_failed',
        message: 'Provider 处理失败',
        recoverable: true
      }
    )
  }
  if (!envelope.data) {
    throw new AppError('parse_failed', 'Provider 未返回数据', 502)
  }
  return envelope.data
}

function wrapResponse<T>(
  provider: Provider,
  operation: 'resolve' | 'list' | 'download' | 'debug',
  response: ProviderResponse<T>,
  startedAt: number
) {
  return toApiResponse(response, operation, startedAt, provider.capabilities)
}

function capabilityResponse<T>(
  provider: Provider,
  operation: 'list' | 'download',
  startedAt: number
) {
  return wrapResponse<T>(
    provider,
    operation,
    providerCapabilityError(provider.id, operation),
    startedAt
  )
}

providersRouter.post('/resolve', async (req, res, next) => {
  const startedAt = Date.now()
  try {
    const provider = requireProviderForInput(req.body?.input)
    const envelope = wrapResponse<ShareResult>(
      provider,
      'resolve',
      await provider.resolveShare({
        shareUrl: req.body?.input,
        passcode: req.body?.passcode
      }),
      startedAt
    )
    const share = requireEnvelopeData(envelope)
    res.json(ok({ providerId: provider.id, share, meta: envelope.meta }))
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
      : capabilityResponse<ListResult>(provider, 'list', startedAt)
    const envelope = 'ok' in response ? response : wrapResponse<ListResult>(provider, 'list', response, startedAt)
    const list = requireEnvelopeData(envelope)
    res.json(ok({ providerId: provider.id, list, meta: envelope.meta }))
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
      : capabilityResponse<DownloadResult>(provider, 'download', startedAt)
    const envelope = 'ok' in response ? response : wrapResponse<DownloadResult>(provider, 'download', response, startedAt)
    const download = requireEnvelopeData(envelope)
    res.json(ok({ providerId: provider.id, download, meta: envelope.meta }))
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
