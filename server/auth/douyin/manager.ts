import { createHash, randomBytes } from 'node:crypto'
import { AppError } from '../../http.js'
import type { DouyinAuthStatus } from '../../../shared/douyinAuth.js'
import type {
  DouyinAuthStore,
  DouyinBrowserDriver,
  DouyinBrowserSession,
  DouyinBrowserSnapshot,
  DouyinCookie,
  DouyinSessionState
} from './types.js'

const MAX_TTL_MS = 120_000
const DEFAULT_TTL_MS = MAX_TTL_MS
const DEFAULT_TICK_MS = 1_000
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const EXPIRED_AUTH_MESSAGE = '登录态已过期，请重新扫码'

type PendingPhase = 'starting' | 'waiting_scan' | 'scanned' | 'verification_required'
type FinalPhase = 'authenticated' | 'expired' | 'error'
type SessionPhase = PendingPhase | FinalPhase

interface ActiveSession {
  id: string
  generation: number
  expiresAt: number
  phase: SessionPhase
  controller: AbortController
  browser?: DouyinBrowserSession
  qrPng?: Buffer
  timer?: ReturnType<typeof setInterval>
  tickInFlight?: Promise<void>
  openPromise?: Promise<void>
  retired: boolean
  finished: boolean
}

const PUBLIC_MESSAGES: Record<DouyinAuthStatus['state'], string> = {
  logged_out: '抖音未登录',
  starting: '抖音扫码登录初始化中',
  waiting_scan: '请使用抖音 App 扫码登录',
  scanned: '已扫码，请在抖音 App 中确认登录',
  authenticated: '抖音已登录',
  expired: '二维码已过期，请重新扫码',
  verification_required: '请在抖音完成验证后继续',
  unavailable: '抖音扫码登录不可用',
  error: '抖音扫码登录失败，请稍后重试'
}

function isPendingPhase(phase: SessionPhase): phase is PendingPhase {
  return phase === 'starting' || phase === 'waiting_scan' || phase === 'scanned' || phase === 'verification_required'
}

function isPng(value: Buffer | undefined): value is Buffer {
  return Boolean(value && value.length >= PNG_SIGNATURE.length && value.length <= 256 * 1024 && PNG_SIGNATURE.equals(value.subarray(0, PNG_SIGNATURE.length)))
}

function cloneCookies(value: DouyinCookie[] | undefined): DouyinCookie[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const copied: DouyinCookie[] = []
  for (const cookie of value) {
    if (!cookie || typeof cookie !== 'object') return undefined
    if (typeof cookie.name !== 'string' || cookie.name.length === 0) return undefined
    if (typeof cookie.value !== 'string' || cookie.value.length === 0) return undefined
    if (typeof cookie.domain !== 'string' || cookie.domain.length === 0) return undefined
    if (typeof cookie.path !== 'string' || cookie.path.length === 0) return undefined
    if (!Number.isFinite(cookie.expires)) return undefined
    if (typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean') return undefined
    if (cookie.sameSite !== 'Strict' && cookie.sameSite !== 'Lax' && cookie.sameSite !== 'None') return undefined
    copied.push({ ...cookie })
  }
  if (!copied.some((cookie) =>
    (cookie.name === 'sessionid' || cookie.name === 'sessionid_ss') && cookie.value.trim().length >= 16
  )) return undefined
  return copied
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|abort/i.test(error.message))
}

/**
 * Owns the single browser-backed Douyin QR login attempt.
 *
 * The browser driver is deliberately kept behind the small interface in types.ts.  This
 * class never exposes browser details or cookie values through its public DTO.
 */
export class DouyinAuthManager {
  private readonly store: DouyinAuthStore
  private readonly driver: DouyinBrowserDriver
  private readonly now: () => number
  private readonly onAuthenticated?: () => void | Promise<void>
  private readonly onLogout?: () => void | Promise<void>
  private readonly ttlMs: number
  private readonly tickMs: number
  private generation = 0
  private active?: ActiveSession
  private readonly savesInFlight = new Set<Promise<void>>()
  private lifecycleQueue: Promise<void> = Promise.resolve()

  constructor(options: {
    store: DouyinAuthStore
    driver: DouyinBrowserDriver
    now?: () => number
    onAuthenticated?: () => void | Promise<void>
    onLogout?: () => void | Promise<void>
    ttlMs?: number
    tickMs?: number
  }) {
    this.store = options.store
    this.driver = options.driver
    this.now = options.now || Date.now
    this.onAuthenticated = options.onAuthenticated
    this.onLogout = options.onLogout
    this.ttlMs = this.normalizePositive(options.ttlMs, DEFAULT_TTL_MS, MAX_TTL_MS)
    this.tickMs = this.normalizePositive(options.tickMs, DEFAULT_TICK_MS)
  }

  start(force = false): Promise<DouyinAuthStatus> {
    return this.enqueueLifecycle(() => this.startInternal(force))
  }

  async status(sessionId?: string): Promise<DouyinAuthStatus> {
    if (sessionId !== undefined) {
      this.validateSessionId(sessionId)
      const current = this.active
      if (!current || current.id !== sessionId || current.retired) {
        throw new AppError('douyin_auth_session_not_found', '抖音登录会话不存在或已过期', 404)
      }
      if (isPendingPhase(current.phase) && this.now() >= current.expiresAt) await this.expire(current)
      const [available, stored] = await Promise.all([this.readAvailable(), this.readStoreState()])
      if (current.phase === 'authenticated' && stored.status !== 'authenticated') {
        return this.globalStatus(available, stored)
      }
      return this.toStatus(current, available, stored)
    }

    const current = this.active
    if (current && isPendingPhase(current.phase) && this.now() >= current.expiresAt) await this.expire(current)
    const [available, stored] = await Promise.all([this.readAvailable(), this.readStoreState()])
    if (this.active && !this.active.retired && this.active.phase !== 'authenticated') {
      return this.toStatus(this.active, available, stored)
    }
    return this.globalStatus(available, stored)
  }

  async image(sessionId: string): Promise<Buffer> {
    this.validateSessionId(sessionId)
    const current = this.active
    if (!current || current.id !== sessionId || current.retired) {
      throw new AppError('douyin_auth_session_not_found', '抖音登录会话不存在或已过期', 404)
    }
    if (isPendingPhase(current.phase) && this.now() >= current.expiresAt) await this.expire(current)
    if ((current.phase !== 'waiting_scan' && current.phase !== 'scanned') || !isPng(current.qrPng)) {
      throw new AppError('douyin_auth_image_unavailable', '抖音二维码暂不可用，请重新扫码', 409)
    }
    return Buffer.from(current.qrPng)
  }

  logout(): Promise<DouyinAuthStatus> {
    return this.enqueueLifecycle(() => this.logoutInternal())
  }

  close(): Promise<void> {
    return this.enqueueLifecycle(() => this.closeInternal())
  }

  private async startInternal(force: boolean): Promise<DouyinAuthStatus> {
    const current = this.active
    if (current && isPendingPhase(current.phase)) {
      if (this.now() >= current.expiresAt) {
        await this.expire(current)
      } else if (!force) {
        const [available, stored] = await Promise.all([this.readAvailable(), this.readStoreState()])
        return this.toStatus(current, available, stored)
      }
    }

    if (!force) {
      const stored = await this.readStoreState()
      if (stored.status === 'authenticated') {
        return this.globalStatus(await this.readAvailable(), stored)
      }
    }

    const previous = this.active
    if (previous) await this.retire(previous)
    await this.waitForSaves()

    const available = await this.readAvailable()
    if (!available) {
      return this.globalStatus(available, await this.readStoreState())
    }

    const session: ActiveSession = {
      id: randomBytes(16).toString('hex'),
      generation: ++this.generation,
      expiresAt: this.now() + this.ttlMs,
      phase: 'starting',
      controller: new AbortController(),
      retired: false,
      finished: false
    }
    this.active = session
    session.openPromise = this.open(session)
    // Do not wait for the browser open (or its first snapshot).  Callers receive
    // the starting phase immediately and can poll the returned session id.
    return this.toStatus(session, available, { override: false, status: 'absent', cookies: [], expiresAt: null })
  }

  private async logoutInternal(): Promise<DouyinAuthStatus> {
    const current = this.active
    if (current) await this.retire(current)

    // A save that was already admitted before logout must settle before revoke.  This
    // preserves the invariant that a late browser callback cannot leave auth persisted.
    await this.waitForSaves()

    try {
      await this.store.revoke()
    } catch {
      throw new AppError('douyin_auth_logout_failed', '抖音登录退出失败，请稍后重试', 503)
    }
    try {
      await this.onLogout?.()
    } catch {
      // Cache invalidation is best effort.  It must not expose provider/runtime errors.
    }
    return this.status()
  }

  private async closeInternal(): Promise<void> {
    const current = this.active
    if (current) await this.retire(current)
    // close() intentionally does not revoke the persisted auth session.
  }

  private async open(session: ActiveSession): Promise<void> {
    let browser: DouyinBrowserSession | undefined
    try {
      browser = await this.driver.open(session.controller.signal)
      if (!this.isCurrent(session)) {
        await this.closeBrowser(browser)
        return
      }
      session.browser = browser
      if (this.now() >= session.expiresAt) {
        await this.expire(session)
        return
      }
      await this.poll(session)
      if (this.isCurrent(session) && isPendingPhase(session.phase)) {
        const timer = setInterval(() => {
          void this.poll(session)
        }, this.tickMs)
        session.timer = timer
        const unref = (timer as unknown as { unref?: () => void }).unref
        unref?.call(timer)
      }
    } catch (error) {
      if (!this.isCurrent(session) || session.controller.signal.aborted || isAbortError(error)) return
      await this.finish(session, 'error')
    }
  }

  private async poll(session: ActiveSession): Promise<void> {
    if (!this.isCurrent(session) || !session.browser) return
    if (session.tickInFlight) return session.tickInFlight
    const run = this.pollOnce(session)
    session.tickInFlight = run
    try {
      await run
    } catch {
      if (this.isCurrent(session)) await this.finish(session, 'error')
    } finally {
      if (session.tickInFlight === run) session.tickInFlight = undefined
    }
  }

  private async pollOnce(session: ActiveSession): Promise<void> {
    if (!this.isCurrent(session) || !session.browser) return
    if (this.now() >= session.expiresAt) {
      await this.expire(session)
      return
    }

    let snapshot: DouyinBrowserSnapshot
    try {
      snapshot = await session.browser.snapshot()
    } catch (error) {
      if (!this.isCurrent(session) || session.controller.signal.aborted || isAbortError(error)) return
      await this.finish(session, 'error')
      return
    }
    if (!this.isCurrent(session)) return
    if (this.now() >= session.expiresAt) {
      await this.expire(session)
      return
    }

    if (isPng(snapshot.qrPng)) session.qrPng = Buffer.from(snapshot.qrPng)
    if (snapshot.state === 'expired') {
      await this.expire(session)
      return
    }
    if (snapshot.state === 'error') {
      await this.finish(session, 'error')
      return
    }
    if (snapshot.state === 'verification_required') {
      session.phase = 'verification_required'
      session.qrPng = undefined
      return
    }
    if (snapshot.state === 'waiting_scan') {
      session.phase = 'waiting_scan'
      return
    }

    session.phase = 'scanned'
    const cookies = cloneCookies(snapshot.cookies)
    if (!cookies || !this.isCurrent(session)) return

    // Only a current scanned snapshot with structurally valid cookies is admitted to
    // persistence.  Verification-required snapshots remain user-action-pending.
    let save: Promise<void>
    try {
      save = this.store.save(cookies)
    } catch {
      await this.finish(session, 'error')
      return
    }
    this.savesInFlight.add(save)
    try {
      await save
    } catch {
      if (this.isCurrent(session)) await this.finish(session, 'error')
      return
    } finally {
      this.savesInFlight.delete(save)
    }
    if (!this.isCurrent(session)) return
    try {
      await this.onAuthenticated?.()
    } catch {
      if (this.isCurrent(session)) await this.finish(session, 'error')
      return
    }
    if (!this.isCurrent(session)) return
    await this.finish(session, 'authenticated')
  }

  private async expire(session: ActiveSession): Promise<void> {
    if (!this.isCurrent(session)) return
    await this.finish(session, 'expired')
  }

  private async finish(session: ActiveSession, phase: FinalPhase): Promise<void> {
    if (!this.isCurrent(session)) return
    session.phase = phase
    session.qrPng = undefined
    session.finished = true
    this.clearTimer(session)
    session.controller.abort()
    const browser = session.browser
    session.browser = undefined
    if (browser) await this.closeBrowser(browser)
  }

  private async retire(session: ActiveSession): Promise<void> {
    if (session.retired) return
    session.retired = true
    if (this.active === session) {
      this.active = undefined
      this.generation += 1
    }
    this.clearTimer(session)
    session.controller.abort()
    const browser = session.browser
    session.browser = undefined
    if (browser) await this.closeBrowser(browser)
  }

  private clearTimer(session: ActiveSession) {
    if (!session.timer) return
    clearInterval(session.timer)
    session.timer = undefined
  }

  private async closeBrowser(browser: DouyinBrowserSession): Promise<void> {
    try {
      await browser.close()
    } catch {
      // Browser cleanup is best effort and never becomes a raw public error.
    }
  }

  private async waitForSaves(): Promise<void> {
    if (this.savesInFlight.size > 0) await Promise.allSettled([...this.savesInFlight])
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation)
    this.lifecycleQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private isCurrent(session: ActiveSession) {
    return this.active === session && this.generation === session.generation && !session.retired && !session.finished
  }

  private async readAvailable(): Promise<boolean> {
    try {
      return (await this.driver.available()) === true
    } catch {
      return false
    }
  }

  private async readStoreState(): Promise<DouyinSessionState> {
    try {
      const state = await this.store.read()
      if (!state || typeof state !== 'object') throw new Error('invalid Douyin store state')
      return state
    } catch {
      return { override: true, status: 'invalid', cookies: [], expiresAt: null }
    }
  }

  private globalStatus(available: boolean, stored: DouyinSessionState): DouyinAuthStatus {
    if (stored.status === 'expired') {
      const status: DouyinAuthStatus = {
        state: 'expired',
        loggedIn: false,
        available,
        message: EXPIRED_AUTH_MESSAGE
      }
      if (Number.isFinite(stored.expiresAt) && (stored.expiresAt as number) > 0) {
        status.expiresAt = new Date(stored.expiresAt as number).toISOString()
      }
      return status
    }
    if (stored.status === 'authenticated') {
      const status: DouyinAuthStatus = {
        state: 'authenticated',
        loggedIn: true,
        available,
        message: PUBLIC_MESSAGES.authenticated
      }
      if (Number.isFinite(stored.expiresAt) && (stored.expiresAt as number) > 0) {
        status.expiresAt = new Date(stored.expiresAt as number).toISOString()
      }
      return status
    }
    const state: DouyinAuthStatus['state'] = available ? 'logged_out' : 'unavailable'
    return { state, loggedIn: false, available, message: PUBLIC_MESSAGES[state] }
  }

  private toStatus(session: ActiveSession, available: boolean, stored: DouyinSessionState): DouyinAuthStatus {
    const status: DouyinAuthStatus = {
      state: session.phase,
      loggedIn: stored.status === 'authenticated',
      available,
      sessionId: session.id,
      message: PUBLIC_MESSAGES[session.phase]
    }
    if (session.phase === 'authenticated') {
      if (Number.isFinite(stored.expiresAt) && (stored.expiresAt as number) > 0) {
        status.expiresAt = new Date(stored.expiresAt as number).toISOString()
      }
    } else {
      status.expiresAt = new Date(session.expiresAt).toISOString()
    }
    if ((session.phase === 'waiting_scan' || session.phase === 'scanned') && isPng(session.qrPng)) {
      const hash = createHash('sha256').update(session.qrPng).digest('hex').slice(0, 16)
      status.qrImageUrl = `/api/auth/douyin/qr/${session.id}/image?v=${hash}`
    }
    return status
  }

  private validateSessionId(sessionId: string) {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new AppError('invalid_douyin_auth_session', '抖音登录会话标识无效', 400)
    }
  }

  private normalizePositive(value: number | undefined, fallback: number, maximum?: number) {
    if (value === undefined || !Number.isFinite(value)) return fallback
    const positive = Math.max(1, Math.floor(value))
    return maximum === undefined ? positive : Math.min(maximum, positive)
  }
}
