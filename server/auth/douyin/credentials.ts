import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '../../http.js'
import { getDefaultDouyinStore } from './sessionStore.js'
import type { DouyinCookie } from './types.js'

function cookieDirectory() {
  const dataRoot = process.env.NETPAN_DATA_DIR || path.resolve(process.cwd(), 'data')
  return path.resolve(dataRoot, 'auth', 'douyin', 'tmp')
}
function safeCookie(cookie: DouyinCookie) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) && !/[\x00-\x20\x7f;]/.test(cookie.value) && (cookie.expires <= 0 || cookie.expires * 1000 > Date.now())
}

/** undefined means no managed session: the legacy administrator configuration may be used. */
export async function managedDouyinCookieHeader(url: URL): Promise<string | undefined> {
  const state = await getDefaultDouyinStore().read()
  if (!state.override) return undefined
  if (state.status !== 'authenticated' || url.protocol !== 'https:') return ''
  return state.cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    const domainMatches = url.hostname === domain || (cookie.domain.startsWith('.') && url.hostname.endsWith('.' + domain))
    const cookiePath = cookie.path || '/'
    const pathMatches = url.pathname === cookiePath || url.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/')
    return domainMatches && pathMatches && safeCookie(cookie)
  }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

export async function clearDouyinTemporaryCredentials() {
  const directory = cookieDirectory()
  let stat
  try { stat = await lstat(directory) } catch { return }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  for (const name of await readdir(directory)) {
    if (!/^session-[0-9a-f]{32}\.cookies$/.test(name)) continue
    const file = path.join(directory, name)
    const info = await lstat(file).catch(() => undefined)
    if (info && (info.isFile() || info.isSymbolicLink())) await unlink(file).catch(() => undefined)
  }
}

/** Plaintext exists only in a private temporary file while the legacy extractor runs. */
export async function withDouyinCookieFile<T>(legacy: string | undefined, consumer: (file: string | undefined) => Promise<T>): Promise<T> {
  const state = await getDefaultDouyinStore().read()
  if (!state.override) return consumer(legacy)
  if (state.status !== 'authenticated') return consumer(undefined)
  const directory = cookieDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('auth_required', '抖音登录缓存不可用，请重新扫码')
  const file = path.join(directory, 'session-' + randomBytes(16).toString('hex') + '.cookies')
  const lines = state.cookies.filter(safeCookie).map(cookie => [
    (cookie.httpOnly ? '#HttpOnly_' : '') + cookie.domain,
    cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE', cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE',
    String(cookie.expires > 0 ? Math.floor(cookie.expires) : 0), cookie.name, cookie.value
  ].join('\t'))
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile('# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n')
    await handle.close()
    return await consumer(file)
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(file).catch(() => undefined)
  }
}
