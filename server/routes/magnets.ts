import { Router } from 'express'
import { ok } from '../http.js'
import { searchByCode } from '../services/magnets/codeSearch.js'
import { searchByKeyword } from '../services/magnets/keywordSearch.js'
import { searchGeneralMagnets } from '../services/magnets/generalSearch.js'

export const magnetsRouter = Router()

magnetsRouter.get('/general-search', async (req, res, next) => {
  try {
    res.json(ok(await searchGeneralMagnets(req.query.q, req.query.category, req.query.source)))
  } catch (error) {
    next(error)
  }
})

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
