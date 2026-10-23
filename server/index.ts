import express, { type ErrorRequestHandler } from 'express'
import type { Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, setRuntimePort } from './config.js'
import { ensureEngineStarted } from './download-engine/engine.js'
import { AppError, fail } from './http.js'
import { structuredLogger } from './logging/structuredLogger.js'
import { downloadDecisionRouter } from './router/downloadDecisionRouter.js'
import { downloadsRouter } from './routes/downloads.js'
import { downloadEngineRouter } from './routes/downloadEngine.js'
import { productRouter } from './routes/product.js'
import { providersRouter } from './routes/providers.js'
import { quarkRouter } from './routes/quark.js'

export const app = express()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const privateWeb = process.env.NETPAN_PRIVATE_WEB === 'true'
const desktopStaticEnabled = privateWeb || String(process.env.QUARK_DESKTOP_STATIC || '').toLowerCase() === 'true'
const desktopRuntimeRoot = String(process.env.QUARK_DESKTOP_ROOT || '').trim()
const desktopStaticDir = desktopRuntimeRoot
  ? path.resolve(desktopRuntimeRoot, 'dist')
  : path.resolve(__dirname, '..', 'dist')

// The API always binds to loopback; private web mode is accessible only via an authenticated HTTPS reverse proxy.
app.use('/api', (req, res, next) => {
  const host = String(req.headers.host || '')
  const hostName = host.replace(/:\d+$/, '').toLowerCase()
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostName)) {
    res.status(403).json(fail('local_api_only', '仅允许本机访问下载服务'))
    return
  }
  const origin = String(req.headers.origin || '')
  if (origin) {
    let originHost = ''
    try {
      const parsed = new URL(origin)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad origin protocol')
      originHost = parsed.hostname.toLowerCase()
    } catch {
      res.status(403).json(fail('local_origin_only', '拒绝非本机网页来源'))
      return
    }
    const permittedOrigin = privateWeb ? String(process.env.NETPAN_PUBLIC_ORIGIN || '').trim() : ''
    const actualOrigin = new URL(origin).origin
    if (privateWeb ? (!permittedOrigin || actualOrigin !== permittedOrigin) : !['localhost', '127.0.0.1', '[::1]'].includes(originHost)) {
      res.status(403).json(fail('local_origin_only', '拒绝非本机网页来源'))
      return
    }
  }
  next()
})
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    result: {
      service: 'quark-link-parser',
      mock: config.quarkMock,
      privateWeb
    }
  })
})

app.use('/api/quark', quarkRouter)
app.use('/api/downloads', downloadsRouter)
app.use('/api/download-engine', downloadEngineRouter)
app.use('/api/providers', providersRouter)
app.use('/api/product', productRouter)
app.use('/api/decision', downloadDecisionRouter)

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
  if (privateWeb && (!process.env.NETPAN_PUBLIC_ORIGIN || !process.env.NETPAN_PUBLIC_ORIGIN.startsWith('https://'))) {
    throw new Error('NETPAN_PRIVATE_WEB requires NETPAN_PUBLIC_ORIGIN=https://your-domain')
  }
  return new Promise<Server>((resolve, reject) => {
    setRuntimePort(port)
    const server = app.listen(port, '127.0.0.1', () => {
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
