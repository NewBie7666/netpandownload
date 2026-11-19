import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError, fail, ok } from '../../server/http.js'
import { runSearch, validateQuery } from './search.js'

export interface PublicSettings {
  origin: string
  proxyToken: string
  port: number
  perIpLimit: number
  globalLimit: number
  concurrency: number
  perIpConcurrency: number
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): PublicSettings {
  const raw = env.PUBLIC_SEARCH_ORIGIN || ''
  const origin = new URL(raw)
  if (origin.protocol !== 'https:' || origin.origin !== raw || origin.username || origin.password) {
    throw new Error('PUBLIC_SEARCH_ORIGIN must be an HTTPS origin without a path')
  }
  const proxyToken = env.PUBLIC_SEARCH_PROXY_TOKEN || ''
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(proxyToken) || proxyToken.startsWith('CHANGE_ME')) throw new Error('PUBLIC_SEARCH_PROXY_TOKEN must contain 32-128 random URL-safe characters')
  function integer(name: string, fallback: number, max: number) {
    const n = Number(env[name] ?? fallback)
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('Invalid ' + name)
    return n
  }
  return { origin: raw, proxyToken, port: integer('PUBLIC_SEARCH_PORT', 3100, 65535),
    perIpLimit: integer('PUBLIC_SEARCH_IP_LIMIT', 20, 100), globalLimit: integer('PUBLIC_SEARCH_GLOBAL_LIMIT', 120, 1000),
    concurrency: integer('PUBLIC_SEARCH_CONCURRENCY', 4, 16), perIpConcurrency: integer('PUBLIC_SEARCH_IP_CONCURRENCY', 2, 4) }
}

export function createPublicApp(settings: PublicSettings, search = runSearch, now = Date.now) {
  const app = express()
  app.disable('x-powered-by')
  app.disable('etag')
  app.set('query parser', 'simple')
  app.set('strict routing', true)
  app.set('case sensitive routing', true)
  app.set('trust proxy', false)
  const ips = new Map<string, { count: number; reset: number; active: number }>()
  let global = { count: 0, reset: 0 }
  let active = 0
  const staticDir = fileURLToPath(new URL('../../../client/', import.meta.url))
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" })
    const supplied = Buffer.from(String(req.headers['x-public-search-token'] || ''))
    const expected = Buffer.from(settings.proxyToken)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.status(403).json(fail('proxy_required', '请通过公开站点访问')); return
    }
    if (req.headers.host !== new URL(settings.origin).host || (req.headers.origin && req.headers.origin !== settings.origin) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      res.status(403).json(fail('origin_rejected', '请求来源不正确')); return
    }
    if (req.originalUrl.length > 1024) { res.status(414).json(fail('invalid_query', '搜索参数过长')); return }
    next()
  })
  // Only these exact method/path pairs are executable. No local app/router is imported.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' || !['/search', '/health'].includes(req.path)) {
      res.status(404).json(fail('not_found', '接口不存在')); return
    }
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) {
      res.status(400).json(fail('invalid_request', '请求不正确')); return
    }
    const ip = String(req.headers['x-real-ip'] || '')
    if (!isIP(ip)) { res.status(403).json(fail('proxy_required', '请通过公开站点访问')); return }
    if (req.path === '/health') { next(); return }
    const time = now()
    for (const [key, bucket] of ips) if (bucket.reset <= time && bucket.active === 0) ips.delete(key)
    if (global.reset <= time) global = { count: 0, reset: time + 60000 }
    let bucket = ips.get(ip)
    if (!bucket) {
      if (ips.size >= 5000) { res.set('Retry-After', '60').status(429).json(fail('rate_limited', '请求过于频繁，请稍后重试')); return }
      bucket = { count: 0, reset: time + 60000, active: 0 }; ips.set(ip, bucket)
    } else if (bucket.reset <= time) { bucket.count = 0; bucket.reset = time + 60000 }
    if (++global.count > settings.globalLimit || ++bucket.count > settings.perIpLimit) {
      res.set('Retry-After', '60').status(429).json(fail('rate_limited', '请求过于频繁，请稍后重试')); return
    }
    if (active >= settings.concurrency || bucket.active >= settings.perIpConcurrency) {
      res.set('Retry-After', '3').status(429).json(fail('busy', '服务繁忙，请稍后重试')); return
    }
    // Hold the concurrency slot until upstream work ends, even if the client disconnects.
    res.locals.bucket = bucket
    next()
  })
  app.get('/api/health', (_req, res) => { res.json(ok({ service: 'public-search' })) })
  app.get('/api/search', async (req, res) => {
    const bucket = res.locals.bucket as { active: number }
    active++; bucket.active++
    try { res.json(ok(await search(validateQuery(req.query)))) }
    catch (error) {
      if (error instanceof AppError && error.status === 400) {
        // Internal parser messages may contain private-product terminology.
        res.status(400).json(fail('invalid_query', '请检查关键词和筛选条件'))
      } else res.status(502).json(fail('sources_unavailable', '搜索源暂时不可用，请稍后重试'))
    } finally { active--; bucket.active-- }
  })
  app.use('/api', (_req, res) => { res.status(404).json(fail('not_found', '接口不存在')) })
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || (req.path !== '/' && !/^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(req.path))) {
      res.status(404).end(); return
    }
    next()
  })
  app.use(express.static(path.resolve(staticDir), { dotfiles: 'deny', fallthrough: true, etag: false, lastModified: false, setHeaders: res => res.setHeader('Cache-Control', 'no-store') }))
  app.use((_req, res) => { res.status(404).end() })
  const handler: express.ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).json(fail('invalid_request', '请求不正确')) }
  app.use(handler)
  return app
}
