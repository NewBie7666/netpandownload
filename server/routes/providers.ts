import { Router } from 'express'
import { ok } from '../http.js'
import {
  findProviderByInput,
  getProvider,
  getProviderDebug,
  recordProviderResolveStatus,
  requireProviderForInput
} from '../providers/registry.js'
import type { ProviderId } from '../providers/types.js'

export const providersRouter = Router()

providersRouter.post('/resolve', async (req, res, next) => {
  try {
    const provider = requireProviderForInput(req.body?.input)
    const share = await provider.resolveShare({
      shareUrl: req.body?.input,
      passcode: req.body?.passcode
    })
    recordProviderResolveStatus('ok')
    res.json(ok({ providerId: provider.id, share }))
  } catch (error) {
    recordProviderResolveStatus('error')
    next(error)
  }
})

providersRouter.post('/list', async (req, res, next) => {
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const list = await provider.list({
      shareId: String(req.body?.shareId || ''),
      stoken: String(req.body?.stoken || ''),
      dirFid: req.body?.dirFid
    })
    recordProviderResolveStatus('ok')
    res.json(ok({ providerId: provider.id, list }))
  } catch (error) {
    recordProviderResolveStatus('error')
    next(error)
  }
})

providersRouter.post('/download', async (req, res, next) => {
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const download = await provider.getDownload({
      shareId: String(req.body?.shareId || ''),
      stoken: String(req.body?.stoken || ''),
      file: req.body?.file,
      sessionId: req.body?.sessionId
    })
    recordProviderResolveStatus('ok')
    res.json(ok({ providerId: provider.id, download }))
  } catch (error) {
    recordProviderResolveStatus('error')
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
    const result = await provider.resolveShare({
      shareUrl: req.body?.input,
      passcode: req.body?.passcode
    })
    recordProviderResolveStatus('ok')
    res.json(ok(result))
  } catch (error) {
    recordProviderResolveStatus('error')
    next(error)
  }
})

providersRouter.post('/debug/list', async (req, res, next) => {
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const result = await provider.list({
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

providersRouter.post('/debug/download', async (req, res, next) => {
  try {
    const provider = getProvider(String(req.body?.providerId || '') as ProviderId)
    const result = await provider.getDownload({
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
