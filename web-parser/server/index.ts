import cors from 'cors'
import express, { type ErrorRequestHandler } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError, fail, ok } from '../../server/http.js'
import { parseWebLink } from './parser.js'
import { assertPureParserMode, rejectPublicMediaResolve } from './riskGate.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const port = Number(process.env.WEB_PARSER_PORT || 5190)

assertPureParserMode()

app.use(cors())
app.use(express.json({ limit: '256kb' }))

app.get('/api/web/health', (_req, res) => {
  res.json(ok({ service: 'netpan-parser-web', mode: 'PURE_PARSER' }))
})

app.post('/api/web/parse', async (req, res, next) => {
  try {
    res.json(ok(await parseWebLink(req.body?.input, req.body?.passcode)))
  } catch (error) {
    next(error)
  }
})

app.post('/api/web/resolve-media', (_req, _res, next) => {
  next(rejectPublicMediaResolve())
})

const staticDir = path.resolve(__dirname, '..', 'dist')
app.use(express.static(staticDir))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next()
    return
  }
  res.sendFile(path.join(staticDir, 'index.html'))
})

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json(fail(error.error, error.message))
    return
  }
  res.status(500).json(fail('internal_error', '解析服务处理失败，请稍后重试'))
}

app.use(errorHandler)

app.listen(port, '127.0.0.1', () => {
  console.info(`NetPan Parser Web listening on http://127.0.0.1:${port}`)
})
