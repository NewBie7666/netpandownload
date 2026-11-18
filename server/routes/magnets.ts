import { Router } from 'express'
import { ok } from '../http.js'
import { searchByCode } from '../services/magnets/codeSearch.js'
import { searchByKeyword } from '../services/magnets/keywordSearch.js'

export const magnetsRouter = Router()

magnetsRouter.get('/search', async (req, res, next) => {
  try {
    // Keep legacy ?code= behavior unchanged for exact searches.
    const result = req.query.q !== undefined
      ? await searchByKeyword(req.query.q)
      : await searchByCode(req.query.code)
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})
