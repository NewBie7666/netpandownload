import cors from 'cors'
import express, { type ErrorRequestHandler } from 'express'
import type { Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, setRuntimePort } from './config.js'
import { ensureEngineStarted } from './download-engine/engine.js'
import { AppError, fail } from './http.js'
import { structuredLogger } from './logging/structuredLogger.js'
import { downloadsRouter } from './routes/downloads.js'
import { downloadEngineRouter } from './routes/downloadEngine.js'
import { productRouter } from './routes/product.js'
import { providersRouter } from './routes/providers.js'
import { quarkRouter } from './routes/quark.js'

export const app = express()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const desktopStaticEnabled = String(process.env.QUARK_DESKTOP_STATIC || '').toLowerCase() === 'true'
const desktopRuntimeRoot = String(process.env.QUARK_DESKTOP_ROOT || '').trim()
const desktopStaticDir = desktopRuntimeRoot
  ? path.resolve(desktopRuntimeRoot, 'dist')
  : path.resolve(__dirname, '..', 'dist')

app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    result: {
      service: 'quark-link-parser',
      mock: config.quarkMock
    }
  })
})

app.use('/api/quark', quarkRouter)
app.use('/api/downloads', downloadsRouter)
app.use('/api/download-engine', downloadEngineRouter)
app.use('/api/providers', providersRouter)
app.use('/api/product', productRouter)

void ensureEngineStarted().catch((error) => {
  structuredLogger.error('download-engine', 'Download engine startup failed', { error })
})

if (desktopStaticEnabled) {
  app.use(express.static(desktopStaticDir))

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next()
      return
    }

    res.sendFile(path.join(desktopStaticDir, 'index.html'))
  })
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json(fail(error.error, error.message))
    return
  }

  structuredLogger.error('http', 'Unhandled server error', { error })
  res.status(500).json(fail('internal_error', '服务端处理失败，请稍后重试'))
}

app.use(errorHandler)

export function startServer(port = config.port) {
  return new Promise<Server>((resolve, reject) => {
    setRuntimePort(port)
    const server = app.listen(port, () => {
      structuredLogger.info('server', 'Quark parser API listening', { port, url: `http://localhost:${port}` })
      resolve(server)
    })

    server.once('error', reject)
  })
}

if (String(process.env.QUARK_EMBEDDED_SERVER || '').toLowerCase() !== 'true') {
  void startServer().catch((error) => {
    structuredLogger.error('server', 'Server startup failed', { error })
    process.exit(1)
  })
}
