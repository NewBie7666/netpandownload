import { Router } from 'express'
import { ok } from '../http.js'
import {
  addEngineTask,
  controlEngineTask,
  listEngineTasks
} from '../download-engine/engine.js'

export const downloadEngineRouter = Router()

downloadEngineRouter.post('/add', async (req, res, next) => {
  try {
    const result = await addEngineTask(req.body)
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadEngineRouter.get('/list', async (_req, res, next) => {
  try {
    const result = await listEngineTasks()
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadEngineRouter.post('/action', async (req, res, next) => {
  try {
    const result = await controlEngineTask(req.body)
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})
