import { Router } from 'express'
import { AppError, ok } from '../http.js'
import {
  findProviderByInput,
  getProvider,
  getProviderDebug,
  recordProviderException,
  recordProviderResult,
  requireProviderForInput
} from '../providers/registry.js'
import { toAppError } from '../providers/providerResponse.js'
import type { DownloadResult, ListResult, ShareResult } from '../../shared/types.js'
import type { ProviderId, ProviderResponse } from '../providers/types.js'

export const providersRouter = Router()

function requireProviderData<T>(response: ProviderResponse<T>) {
  recordProviderResult(response)
  if (response.status === 'error') {
    throw toAppError(response.error || {
      code: 'parse_failed',
      message: 'Provider 处理失败',
      recoverable: true
    })
  }
  if (!response.data) {
    throw new AppError('parse_failed', 'Provider 未返回数据', 502)
  }
  return response.data
}

providersRouter.post('/resolve', async (req, res, next) => {
  try {
    const provider = requireProviderForInput(req.body?.input)
    const response = await provider.resolveShare({
      shareUrl: req.body?.input,
      passcode: req.body?.passcode
    })
    const share = requireProviderData<ShareResult>(response)
    res.json(ok({ providerId: provider.id, share, meta: response.meta }))
  } catch (error) {
    recordProviderException(error)
    next(error)
  }
})

providersRouter.post('/list', async (req, res, next) => {
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const response = await provider.list({
      shareId: String(req.body?.shareId || ''),
      stoken: String(req.body?.stoken || ''),
      dirFid: req.body?.dirFid
    })
    const list = requireProviderData<ListResult>(response)
    res.json(ok({ providerId: provider.id, list, meta: response.meta }))
  } catch (error) {
    recordProviderException(error)
    next(error)
  }
})

providersRouter.post('/download', async (req, res, next) => {
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const response = await provider.getDownload({
      shareId: String(req.body?.shareId || ''),
      stoken: String(req.body?.stoken || ''),
      file: req.body?.file,
      sessionId: req.body?.sessionId
    })
    const download = requireProviderData<DownloadResult>(response)
    res.json(ok({ providerId: provider.id, download, meta: response.meta }))
  } catch (error) {
    recordProviderException(error)
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
  try {
    const provider = requireProviderForInput(req.body?.input)
    const response = await provider.resolveShare({
      shareUrl: req.body?.input,
      passcode: req.body?.passcode
    })
    recordProviderResult(response)
    res.json(ok(response))
  } catch (error) {
    recordProviderException(error)
    next(error)
  }
})

providersRouter.post('/debug/list', async (req, res, next) => {
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const response = await provider.list({
      shareId: req.body?.shareId,
      stoken: req.body?.stoken,
      dirFid: req.body?.dirFid
    })
    recordProviderResult(response)
    res.json(ok(response))
  } catch (error) {
    recordProviderException(error)
    next(error)
  }
})

providersRouter.post('/debug/download', async (req, res, next) => {
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const response = await provider.getDownload({
      shareId: req.body?.shareId,
      stoken: req.body?.stoken,
      file: req.body?.file,
      sessionId: req.body?.sessionId
    })
    recordProviderResult(response)
    res.json(ok(response))
  } catch (error) {
    recordProviderException(error)
    next(error)
  }
})
