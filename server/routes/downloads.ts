import { Router } from 'express'
import { ok } from '../http.js'
import {
  addDownloadTask,
  getDownloadHealth,
  getDownloadTaskStatus,
  listDownloadTasks,
  openDownloadDirectory,
  pauseDownloadTask,
  removeDownloadTask,
  resumeDownloadTask
} from '../downloader/downloadService.js'

export const downloadsRouter = Router()

downloadsRouter.post('/add', async (req, res, next) => {
  try {
    const result = await addDownloadTask(req.body)
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.get('/active', async (_req, res, next) => {
  try {
    const result = await listDownloadTasks()
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.get('/health', async (_req, res, next) => {
  try {
    const result = await getDownloadHealth()
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.get('/status/:gid', async (req, res, next) => {
  try {
    const result = await getDownloadTaskStatus(String(req.params.gid || ''))
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.post('/pause/:gid', async (req, res, next) => {
  try {
    const result = await pauseDownloadTask(String(req.params.gid || ''))
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.post('/resume/:gid', async (req, res, next) => {
  try {
    const result = await resumeDownloadTask(String(req.params.gid || ''))
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.post('/remove/:gid', async (req, res, next) => {
  try {
    const result = await removeDownloadTask(String(req.params.gid || ''))
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.get('/open-dir', async (_req, res, next) => {
  try {
    const result = await openDownloadDirectory()
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})
