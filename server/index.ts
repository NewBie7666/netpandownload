import cors from 'cors'
import express, { type ErrorRequestHandler } from 'express'
import type { Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, setRuntimePort } from './config.js'
import { downloadsRouter } from './routes/downloads.js'
import { AppError, fail } from './http.js'
import { quarkRouter } from './routes/quark.js'
import { providersRouter } from './routes/providers.js'

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
app.use('/api/providers', providersRouter)

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

  res.status(500).json(fail('internal_error', '服务端处理失败，请稍后重试'))
}

app.use(errorHandler)

export function startServer(port = config.port) {
  return new Promise<Server>((resolve, reject) => {
    setRuntimePort(port)
    const server = app.listen(port, () => {
      console.log(`Quark parser API listening on http://localhost:${port}`)
      resolve(server)
    })

    server.once('error', reject)
  })
}

if (String(process.env.QUARK_EMBEDDED_SERVER || '').toLowerCase() !== 'true') {
  void startServer().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
