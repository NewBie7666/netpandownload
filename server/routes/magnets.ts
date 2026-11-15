import { Router } from 'express'
import { ok } from '../http.js'
import { searchByCode } from '../services/magnets/codeSearch.js'

export const magnetsRouter = Router()

magnetsRouter.get('/search', async (req, res, next) => {
  try {
    res.json(ok(await searchByCode(req.query.code)))
  } catch (error) {
    next(error)
  }
})
