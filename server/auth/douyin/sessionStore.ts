import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DouyinAuthStore, DouyinCookie, DouyinSessionState } from './types.js'

const AES_ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const MAX_FILE_BYTES = 256 * 1024
const MAX_COOKIE_COUNT = 512
const MAX_COOKIE_NAME_BYTES = 256
const MAX_COOKIE_VALUE_BYTES = 8192
const MAX_COOKIE_PATH_BYTES = 2048
const MAX_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const COOKIE_DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ALLOWED_DOMAIN_ROOTS = ['douyin.com', 'iesdouyin.com'] as const
const AUTH_COOKIE_NAMES = new Set(['sessionid', 'sessionid_ss'])
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0

// DouyinCookie.expires follows Playwright/Netscape Unix seconds. SessionState.expiresAt remains Unix milliseconds.
function cookieExpiresAtMs(expires: number): number {
  if (expires <= 0) return 0
  const milliseconds = expires * 1000
  return Number.isFinite(milliseconds) ? milliseconds : Number.MAX_SAFE_INTEGER
}

type PersistedStatus = 'authenticated' | 'revoked'

interface PersistedSession {
  version: 1
  status: PersistedStatus
  cookies: DouyinCookie[]
  expiresAt: number | null
}

interface EncryptedEnvelope {
  version: 1
  iv: string
  tag: string
  data: string
}

const operationQueues = new Map<string, Promise<void>>()

function invalidState(): DouyinSessionState {
  return { override: true, status: 'invalid', cookies: [], expiresAt: null }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function decodeBase64(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('invalid encrypted session encoding')
  }
  const decoded = Buffer.from(value, 'base64')
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new Error('invalid encrypted session encoding')
  }
  return decoded
}

function isAllowedCookieDomain(value: string): boolean {
  if (value.length === 0 || value.length > 254 || /[\r\n\u0000-\u0020/:\\]/.test(value)) return false
  const hostname = value.startsWith('.') ? value.slice(1) : value
  if (hostname.length === 0 || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) return false
  const labels = hostname.split('.')
  if (labels.some((label) => !COOKIE_DOMAIN_LABEL_RE.test(label))) return false
  return ALLOWED_DOMAIN_ROOTS.some((root) => hostname === root || hostname.endsWith(`.${root}`))
}

function validateCookie(cookie: unknown, requirePositiveExpiry: boolean): DouyinCookie {
  const value = asRecord(cookie)
  if (!value || typeof value.name !== 'string' || typeof value.value !== 'string' || typeof value.domain !== 'string' ||
      typeof value.path !== 'string' || typeof value.expires !== 'number' || !Number.isFinite(value.expires) ||
      typeof value.httpOnly !== 'boolean' || typeof value.secure !== 'boolean' ||
      (value.sameSite !== 'Strict' && value.sameSite !== 'Lax' && value.sameSite !== 'None')) {
    throw new Error('invalid Douyin cookie')
  }
  const domain = value.domain.toLowerCase()
  if (!isAllowedCookieDomain(domain)) {
    throw new Error('invalid Douyin cookie domain')
  }
  if (value.name.length === 0 || Buffer.byteLength(value.name, 'utf8') > MAX_COOKIE_NAME_BYTES || !COOKIE_NAME_RE.test(value.name)) {
    throw new Error('invalid Douyin cookie name')
  }
  if (Buffer.byteLength(value.value, 'utf8') > MAX_COOKIE_VALUE_BYTES || /[\r\n\u0000-\u001f\u007f]/.test(value.value)) {
    throw new Error('invalid Douyin cookie value')
  }
  if (!value.path.startsWith('/') || Buffer.byteLength(value.path, 'utf8') > MAX_COOKIE_PATH_BYTES || /[\r\n\u0000-\u001f\u007f]/.test(value.path)) {
    throw new Error('invalid Douyin cookie path')
  }
  if (requirePositiveExpiry && value.expires <= 0) {
    throw new Error('invalid persisted Douyin cookie expiry')
  }
  return {
    name: value.name,
    value: value.value,
    domain,
    path: value.path,
    expires: value.expires,
    httpOnly: value.httpOnly,
    secure: value.secure,
    sameSite: value.sameSite
  }
}

function authCookie(cookie: DouyinCookie): boolean {
  return AUTH_COOKIE_NAMES.has(cookie.name) && cookie.value.trim().length >= 16
}

function sameCookie(a: DouyinCookie, b: DouyinCookie): boolean {
  return a.name === b.name && a.domain === b.domain && a.path === b.path
}

export class DouyinSessionStore implements DouyinAuthStore {
  private readonly root: string
  private readonly keyPath: string
  private readonly sessionPath: string

  constructor(root: string, private readonly now: () => number = Date.now) {
    if (typeof root !== 'string' || root.length === 0) throw new Error('Douyin session root is required')
    this.root = path.resolve(root)
    this.keyPath = path.join(this.root, '.key')
    this.sessionPath = path.join(this.root, '.session.enc')
  }

  read(): Promise<DouyinSessionState> {
    return this.enqueue(async () => {
      try {
        await this.ensureRoot()
        const raw = await this.readBoundedFile(this.sessionPath)
        const key = await this.readExistingKey()
        if (raw === undefined) {
          // A stray key is harmless, but a malformed/symlink key is not. The
          // check above deliberately keeps that distinction fail-closed.
          return { override: false, status: 'absent', cookies: [], expiresAt: null }
        }
        if (!key) return invalidState()
        const session = this.decryptSession(raw, key)
        return this.publicState(session)
      } catch {
        // A local auth store must never make callers fall back to an older,
        // potentially unrelated cookie source after corruption or tampering.
        return invalidState()
      }
    })
  }

  save(cookies: DouyinCookie[]): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureRoot()
      const session = this.prepareSession(cookies)
      const key = await this.getOrCreateKey()
      await this.writeEncryptedSession(session, key)
    })
  }

  revoke(): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureRoot()
      const key = await this.getOrCreateKey()
      await this.writeEncryptedSession({
        version: 1,
        status: 'revoked',
        cookies: [],
        expiresAt: null
      }, key)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = operationQueues.get(this.root) || Promise.resolve()
    const next = previous.then(operation, operation)
    const settled = next.then(() => undefined, () => undefined)
    operationQueues.set(this.root, settled)
    void settled.then(
      () => { if (operationQueues.get(this.root) === settled) operationQueues.delete(this.root) },
      () => { if (operationQueues.get(this.root) === settled) operationQueues.delete(this.root) }
    )
    return next
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isFinite(value)) throw new Error('invalid clock')
    return value
  }

  private async ensureRoot(): Promise<void> {
    try {
      const info = await lstat(this.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid Douyin session directory')
    } catch (error) {
      if (!isNotFound(error)) throw error
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const info = await lstat(this.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid Douyin session directory')
    }
    await chmod(this.root, 0o700)
  }

  private async readBoundedFile(filePath: string): Promise<Buffer | undefined> {
    let info
    try {
      info = await lstat(filePath)
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new Error('invalid Douyin session file')
    }

    const flags = fsConstants.O_RDONLY | NO_FOLLOW
    const handle = await open(filePath, flags)
    try {
      const openedInfo = await handle.stat()
      if (!openedInfo.isFile() || openedInfo.size > MAX_FILE_BYTES) throw new Error('invalid Douyin session file')
      const data = await handle.readFile()
      if (data.length > MAX_FILE_BYTES) throw new Error('invalid Douyin session file')
      return data
    } finally {
      await handle.close()
    }
  }

  private async readExistingKey(): Promise<Buffer | undefined> {
    const raw = await this.readBoundedFile(this.keyPath)
    if (raw === undefined) return undefined
    if (raw.length !== KEY_BYTES) throw new Error('invalid Douyin session key')
    return raw
  }

  private async getOrCreateKey(): Promise<Buffer> {
    const existing = await this.readExistingKey()
    if (existing) return existing

    const key = randomBytes(KEY_BYTES)
    try {
      const handle = await open(this.keyPath, 'wx', 0o600)
      try {
        await handle.writeFile(key)
        await handle.sync()
        await handle.chmod(0o600)
      } finally {
        await handle.close()
      }
      return key
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const raced = await this.readKeyAfterRace()
      if (!raced) throw new Error('Douyin session key race failed')
      return raced
    }
  }

  private async readKeyAfterRace(): Promise<Buffer | undefined> {
    let lastError: unknown
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const key = await this.readExistingKey()
        if (key) return key
      } catch (error) {
        lastError = error
        try {
          const info = await lstat(this.keyPath)
          if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES || info.size >= KEY_BYTES) throw error
        } catch (inspectError) {
          if (isNotFound(inspectError)) {
            lastError = inspectError
          } else {
            throw inspectError === error ? error : inspectError
          }
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    if (lastError) throw lastError
    return undefined
  }

  private prepareSession(cookies: DouyinCookie[]): PersistedSession {
    if (!Array.isArray(cookies) || cookies.length === 0 || cookies.length > MAX_COOKIE_COUNT) {
      throw new Error('Douyin login did not provide cookies')
    }
    const now = this.currentTime()
    const valid: DouyinCookie[] = []
    for (const rawCookie of cookies) {
      const cookie = validateCookie(rawCookie, false)
      if (cookieExpiresAtMs(cookie.expires) > 0 && cookieExpiresAtMs(cookie.expires) <= now) continue
      valid.push(cookie)
    }
    const auth = valid.filter(authCookie)
    if (auth.length === 0) throw new Error('Douyin login did not provide an auth cookie')

    let authExpiresAt: number | null = null
    for (const cookie of auth) {
      const cookieExpiry = cookieExpiresAtMs(cookie.expires)
      if (cookieExpiry > 0 && (authExpiresAt === null || cookieExpiry < authExpiresAt)) authExpiresAt = cookieExpiry
    }
    const expiresAt = Math.min(authExpiresAt ?? now + MAX_SESSION_TTL_MS, now + MAX_SESSION_TTL_MS)
    if (expiresAt <= now) throw new Error('Douyin auth cookie is expired')

    const storedCookies: DouyinCookie[] = []
    const maxCookieExpiry = Math.floor(expiresAt / 1000) - 1
    for (const cookie of valid) {
      const cookieExpires = cookie.expires > 0
        ? Math.floor(cookie.expires) - 1
        : Math.floor((now + MAX_SESSION_TTL_MS) / 1000) - 1
      const expires = Math.min(cookieExpires, maxCookieExpiry)
      if (expires <= 0 || cookieExpiresAtMs(expires) <= now) continue
      const normalized = { ...cookie, expires }
      const duplicateIndex = storedCookies.findIndex((item) => sameCookie(item, cookie))
      if (duplicateIndex >= 0) storedCookies[duplicateIndex] = normalized
      else storedCookies.push(normalized)
    }
    if (!storedCookies.some(authCookie)) throw new Error('Douyin auth cookie is expired')
    return { version: 1, status: 'authenticated', cookies: storedCookies, expiresAt }
  }

  private decryptSession(raw: Buffer, key: Buffer): PersistedSession {
    if (raw.length === 0 || raw.length > MAX_FILE_BYTES) throw new Error('invalid encrypted session')
    const envelope = asRecord(JSON.parse(raw.toString('utf8')))
    if (!envelope || envelope.version !== 1) throw new Error('invalid encrypted session')
    const iv = decodeBase64(envelope.iv, IV_BYTES)
    const tag = decodeBase64(envelope.tag, AUTH_TAG_BYTES)
    const data = decodeBase64(envelope.data)
    const decipher = createDecipheriv(AES_ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(data), decipher.final()])
    if (plain.length === 0 || plain.length > MAX_FILE_BYTES) throw new Error('invalid encrypted session')
    const persisted = asRecord(JSON.parse(plain.toString('utf8')))
    if (!persisted || persisted.version !== 1 || (persisted.status !== 'authenticated' && persisted.status !== 'revoked') ||
        !Array.isArray(persisted.cookies) || persisted.cookies.length > MAX_COOKIE_COUNT ||
        (persisted.expiresAt !== null && (typeof persisted.expiresAt !== 'number' || !Number.isFinite(persisted.expiresAt)))) {
      throw new Error('invalid encrypted session')
    }
    const cookies = persisted.cookies.map((cookie) => validateCookie(cookie, true))
    if (persisted.status === 'revoked' && cookies.length !== 0) throw new Error('invalid revoked Douyin session')
    if (persisted.status === 'authenticated' && (persisted.expiresAt === null || persisted.expiresAt <= 0)) {
      throw new Error('invalid authenticated Douyin session')
    }
    return {
      version: 1,
      status: persisted.status,
      cookies,
      expiresAt: persisted.expiresAt as number | null
    }
  }

  private publicState(session: PersistedSession): DouyinSessionState {
    if (session.status === 'revoked') {
      return { override: true, status: 'logged_out', cookies: [], expiresAt: null }
    }
    const now = this.currentTime()
    if (session.expiresAt === null || session.expiresAt <= now) {
      return { override: true, status: 'expired', cookies: [], expiresAt: session.expiresAt }
    }
    const cookies = session.cookies.filter((cookie) => cookieExpiresAtMs(cookie.expires) > now)
    if (!cookies.some(authCookie)) return invalidState()
    return { override: true, status: 'authenticated', cookies, expiresAt: session.expiresAt }
  }

  private encryptSession(session: PersistedSession, key: Buffer): Buffer {
    const plain = Buffer.from(JSON.stringify(session), 'utf8')
    if (plain.length > MAX_FILE_BYTES) throw new Error('Douyin session is too large')
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(AES_ALGORITHM, key, iv)
    const data = Buffer.concat([cipher.update(plain), cipher.final()])
    const envelope: EncryptedEnvelope = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    }
    const encoded = Buffer.from(JSON.stringify(envelope), 'utf8')
    if (encoded.length > MAX_FILE_BYTES) throw new Error('Douyin session is too large')
    return encoded
  }

  private async writeEncryptedSession(session: PersistedSession, key: Buffer): Promise<void> {
    const encoded = this.encryptSession(session, key)
    const target = await lstat(this.sessionPath).catch((error: unknown) => isNotFound(error) ? undefined : Promise.reject(error))
    if (target && (target.isSymbolicLink() || !target.isFile())) throw new Error('invalid Douyin session file')

    const tempPath = path.join(this.root, `.session.enc.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
    try {
      const handle = await open(tempPath, 'wx', 0o600)
      try {
        await handle.writeFile(encoded)
        await handle.sync()
        await handle.chmod(0o600)
      } finally {
        await handle.close()
      }
      const currentTarget = await lstat(this.sessionPath).catch((error: unknown) => isNotFound(error) ? undefined : Promise.reject(error))
      if (currentTarget && (currentTarget.isSymbolicLink() || !currentTarget.isFile())) throw new Error('invalid Douyin session file')
      await rename(tempPath, this.sessionPath)
    } finally {
      await rm(tempPath, { force: true })
    }
  }
}

let defaultStore: { root: string; store: DouyinSessionStore } | undefined

export function getDefaultDouyinStore(): DouyinSessionStore {
  const dataRoot = process.env.NETPAN_DATA_DIR?.trim() || path.join(process.cwd(), 'data')
  const root = path.resolve(dataRoot, 'auth', 'douyin')
  if (!defaultStore || defaultStore.root !== root) {
    defaultStore = { root, store: new DouyinSessionStore(root) }
  }
  return defaultStore.store
}
