import { Router } from 'express'
import { ok } from '../http.js'
import { buildDashboard } from '../product/dashboardService.js'
import { archiveTerminalTasks, getDownloadHistory } from '../product/historyService.js'
import { getUnifiedTasks } from '../product/taskAggregator.js'

export const productRouter = Router()

productRouter.get('/tasks', async (_req, res, next) => {
  try {
    const tasks = await getUnifiedTasks()
    await archiveTerminalTasks(tasks)
    res.json(ok({ tasks }))
  } catch (error) {
    next(error)
  }
})

productRouter.get('/dashboard', async (_req, res, next) => {
  try {
    const tasks = await getUnifiedTasks()
    const history = await archiveTerminalTasks(tasks)
    res.json(ok(buildDashboard(tasks, history)))
  } catch (error) {
    next(error)
  }
})

productRouter.get('/history', async (_req, res, next) => {
  try {
    const tasks = await getUnifiedTasks()
    await archiveTerminalTasks(tasks)
    res.json(ok(await getDownloadHistory()))
  } catch (error) {
    next(error)
  }
})
