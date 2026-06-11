import { Router } from 'express'
import { getShareFiles } from '../services/quark/share.js'
import { listQuarkFiles } from '../services/quark/list.js'
import { getQuarkDownloadUrl, proxyQuarkDownload } from '../services/quark/download.js'
import { quarkApi } from '../adapters/quarkApi.js'
import { ok } from '../http.js'

export const quarkRouter = Router()

quarkRouter.post('/share', async (req, res, next) => {
  try {
    const result = await getShareFiles(req.body?.shareUrl, req.body?.passcode)
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

quarkRouter.post('/list', async (req, res, next) => {
  try {
    const result = await listQuarkFiles(req.body?.shareId, req.body?.stoken, req.body?.dirFid)
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

quarkRouter.post('/download', async (req, res, next) => {
  try {
    const result = await getQuarkDownloadUrl(
      req.body?.shareId,
      req.body?.stoken,
      req.body?.file,
      req.body?.sessionId
    )
    res.json(ok(result))
  } catch (error) {
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
