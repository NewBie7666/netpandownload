import { createPublicApp, readSettings } from './app.js'

try {
  const settings = readSettings()
  const server = createPublicApp(settings).listen(settings.port, '127.0.0.1', () => {
    console.info('Public search listening on 127.0.0.1:' + settings.port)
  })
  // This bounds receipt of the client request, not the upstream search response.
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 5000
  server.maxHeadersCount = 40
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 15000).unref()
  })
  server.on('error', () => { console.error('Public search listener failed'); process.exit(1) })
} catch {
  console.error('Public search configuration invalid: check PUBLIC_SEARCH_ORIGIN and PUBLIC_SEARCH_PROXY_TOKEN')
  process.exit(1)
}
