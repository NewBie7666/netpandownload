import dotenv from 'dotenv'

dotenv.config()

let runtimePort = Number(process.env.PORT || 3000)

export const config = {
  port: runtimePort,
  quarkCookie: String(process.env.QUARK_COOKIE || '').trim(),
  quarkUa: String(process.env.QUARK_UA || '').trim(),
  quarkReferer: String(process.env.QUARK_REFERER || '').trim(),
  quarkMock: String(process.env.QUARK_MOCK || '').toLowerCase() === 'true',
  downloadCacheTtlSeconds: Math.max(
    1,
    Number(process.env.QUARK_DOWNLOAD_CACHE_TTL_SECONDS || 600)
  )
}

export function hasQuarkCredentials() {
  return Boolean(config.quarkCookie && config.quarkUa)
}

export function setRuntimePort(port: number) {
  runtimePort = port
  config.port = port
}

export function getRuntimePort() {
  return runtimePort
}
