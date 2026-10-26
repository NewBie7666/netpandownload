import { Router, type NextFunction, type Request, type Response } from 'express'
import { DouyinAuthManager } from '../auth/douyin/manager.js'
import { AppError, ok } from '../http.js'

const GENERIC_ERROR = new AppError('douyin_auth_error', '抖音登录服务暂不可用，请稍后重试', 503)

function publicError(error: unknown) {
  return error instanceof AppError ? error : GENERIC_ERROR
}

function forward(next: NextFunction, error: unknown) {
  next(publicError(error))
}

type DouyinAuthManagerLike = Pick<DouyinAuthManager, 'status' | 'start' | 'image' | 'logout'>

/** Build the public-only QR authentication router for a DouyinAuthManager. */
export function createDouyinAuthRouter(manager: DouyinAuthManagerLike): Router {
  const router = Router()
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawSessionId = req.query.sessionId
      const sessionId = rawSessionId === undefined
        ? undefined
        : typeof rawSessionId === 'string'
          ? rawSessionId
          : ''
      res.json(ok(await manager.status(sessionId)))
    } catch (error) {
      forward(next, error)
    }
  })

  router.post('/qr', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(ok(await manager.start(req.body?.force === true)))
    } catch (error) {
      forward(next, error)
    }
  })

  router.get('/qr/:sessionId/image', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const image = await manager.image(String(req.params.sessionId || ''))
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.end(image)
    } catch (error) {
      forward(next, error)
    }
  })

  router.post('/logout', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(ok(await manager.logout()))
    } catch (error) {
      forward(next, error)
    }
  })

  return router
}
