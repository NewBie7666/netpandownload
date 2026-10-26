export type DouyinAuthPhase = 'logged_out' | 'starting' | 'waiting_scan' | 'scanned' | 'authenticated' | 'expired' | 'verification_required' | 'unavailable' | 'error'

/** Public state only. Cookie values, QR tickets and browser details must never cross this contract. */
export interface DouyinAuthStatus {
  state: DouyinAuthPhase
  loggedIn: boolean
  available: boolean
  sessionId?: string
  expiresAt?: string
  qrImageUrl?: string
  message: string
}
