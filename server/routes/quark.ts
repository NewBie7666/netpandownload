import { Router } from 'express'
import { proxyQuarkDownload } from '../services/quark/download.js'
import { quarkApi } from '../adapters/quarkApi.js'
import { ok } from '../http.js'
import {
  getProvider,
  recordProviderException,
  recordProviderResult,
  requireProviderForInput
} from '../providers/registry.js'
import { toAppError } from '../providers/providerResponse.js'
import type { ProviderResponse } from '../providers/types.js'

export const quarkRouter = Router()
const quarkProvider = getProvider('quark')

function requireProviderData<T>(response: ProviderResponse<T>) {
  recordProviderResult(response)
  if (response.status === 'error') {
    throw toAppError(response.error || {
      code: 'parse_failed',
      message: 'Provider 处理失败',
      recoverable: true
    })
  }
  return response.data as T
}

quarkRouter.post('/share', async (req, res, next) => {
  try {
    const provider = requireProviderForInput(req.body?.shareUrl)
    const result = await provider.resolveShare({
      shareUrl: req.body?.shareUrl,
      passcode: req.body?.passcode
    })
    res.json(ok(requireProviderData(result)))
  } catch (error) {
    recordProviderException(error)
    next(error)
  }
})

quarkRouter.post('/list', async (req, res, next) => {
  try {
    const result = await quarkProvider.list({
      shareId: req.body?.shareId,
      stoken: req.body?.stoken,
      dirFid: req.body?.dirFid
    })
    res.json(ok(requireProviderData(result)))
  } catch (error) {
    recordProviderException(error)
    next(error)
  }
})

quarkRouter.post('/download', async (req, res, next) => {
  try {
    const result = await quarkProvider.getDownload({
      shareId: req.body?.shareId,
      stoken: req.body?.stoken,
      file: req.body?.file,
      sessionId: req.body?.sessionId
    })
    res.json(ok(requireProviderData(result)))
  } catch (error) {
    recordProviderException(error)
    next(error)
  }
})

quarkRouter.get('/download-proxy', async (req, res, next) => {
  try {
    await proxyQuarkDownload(req, res)
  } catch (error) {
    next(error)
  }
})

quarkRouter.post('/auth/qrcode', async (_req, res, next) => {
  try {
    const result = await quarkApi.createQrLoginSession()
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

quarkRouter.get('/auth/status', async (req, res, next) => {
  try {
    const result = await quarkApi.getQrLoginStatus(String(req.query.sessionId || ''))
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

quarkRouter.post('/auth/logout', async (req, res, next) => {
  try {
    quarkApi.clearQrLoginSession(req.body?.sessionId)
    res.json(ok({ loggedOut: true }))
  } catch (error) {
    next(error)
  }
})
