import { Router } from 'express'
import { proxyQuarkDownload } from '../services/quark/download.js'
import { quarkApi } from '../adapters/quarkApi.js'
import { ok } from '../http.js'
import {
  getProvider,
  recordProviderResolveStatus,
  requireProviderForInput
} from '../providers/registry.js'

export const quarkRouter = Router()
const quarkProvider = getProvider('quark')

quarkRouter.post('/share', async (req, res, next) => {
  try {
    const provider = requireProviderForInput(req.body?.shareUrl)
    const result = await provider.resolveShare({
      shareUrl: req.body?.shareUrl,
      passcode: req.body?.passcode
    })
    recordProviderResolveStatus('ok')
    res.json(ok(result))
  } catch (error) {
    recordProviderResolveStatus('error')
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
    recordProviderResolveStatus('ok')
    res.json(ok(result))
  } catch (error) {
    recordProviderResolveStatus('error')
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
    recordProviderResolveStatus('ok')
    res.json(ok(result))
  } catch (error) {
    recordProviderResolveStatus('error')
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
