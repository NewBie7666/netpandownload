import { Router } from 'express'
import { ok } from '../http.js'
import { getProviderDebug } from '../providers/registry.js'

export const providersRouter = Router()

providersRouter.get('/debug', (_req, res) => {
  res.json(ok(getProviderDebug()))
})
