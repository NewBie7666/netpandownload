import type { DouyinAuthPhase } from '../../../shared/douyinAuth.js'

export interface DouyinCookie {
  name: string
  value: string
  domain: string
  path: string
  /** Unix seconds, matching Playwright/Netscape; -1 denotes a browser session cookie. */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface DouyinSessionState {
  override: boolean
  status: 'absent' | 'authenticated' | 'expired' | 'logged_out' | 'invalid'
  cookies: DouyinCookie[]
  expiresAt: number | null
}

export interface DouyinAuthStore {
  read(): Promise<DouyinSessionState>
  save(cookies: DouyinCookie[]): Promise<void>
  revoke(): Promise<void>
}

export interface DouyinBrowserSnapshot {
  state: Extract<DouyinAuthPhase, 'waiting_scan' | 'scanned' | 'verification_required' | 'expired' | 'error'>
  qrPng?: Buffer
  cookies?: DouyinCookie[]
}

export interface DouyinBrowserSession {
  snapshot(): Promise<DouyinBrowserSnapshot>
  close(): Promise<void>
}

export interface DouyinBrowserDriver {
  available(): Promise<boolean>
  open(signal: AbortSignal): Promise<DouyinBrowserSession>
}
