import { Router } from 'express'
import { createReadStream } from 'node:fs'
import { ok } from '../http.js'
import { scanPageForFiles } from '../downloader/pageLinkScanner.js'
import {
  addDownloadTask,
  addDirectDownloadTask,
  getDownloadHealth,
  getDownloadSettings,
  getDownloadTaskStatus,
  getCompletedDownloadFile,
  listDownloadTasks,
  openDownloadDirectory,
  pauseDownloadTask,
  removeDownloadTask,
  resumeDownloadTask,
  updateDownloadSettings
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

downloadsRouter.post('/direct', async (req, res, next) => {
  try {
    res.json(ok(await addDirectDownloadTask(req.body)))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.post('/scan-page', async (req, res, next) => {
  try {
    res.json(ok(await scanPageForFiles(req.body)))
  } catch (error) {
    next(error)
  }
})

/** Browser handoff: download the completed file to the device making this request. */
downloadsRouter.get('/file/:gid', async (req, res, next) => {
  try {
    const file = await getCompletedDownloadFile(String(req.params.gid || ''))
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8\'\'${encodeURIComponent(file.name)}`)
    res.setHeader('Content-Length', String(file.size))
    res.setHeader('Cache-Control', 'private, no-store')
    const stream = createReadStream(file.absolutePath)
    stream.on('error', (error) => {
      if (!res.headersSent) next(error)
      else res.destroy(error)
    })
    stream.pipe(res)
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

downloadsRouter.get('/settings', async (_req, res, next) => {
  try {
    const result = await getDownloadSettings()
    res.json(ok(result))
  } catch (error) {
    next(error)
  }
})

downloadsRouter.post('/settings', async (req, res, next) => {
  try {
    const result = await updateDownloadSettings(req.body)
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
    const result = await removeDownloadTask(String(req.params.gid || ''), req.body)
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
