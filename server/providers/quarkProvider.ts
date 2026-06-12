import { getQuarkDownloadUrl } from '../services/quark/download.js'
import { listQuarkFiles } from '../services/quark/list.js'
import { getShareFiles } from '../services/quark/share.js'
import type { Provider } from './types.js'

function normalizePotentialQuarkUrl(input: string) {
  const trimmed = String(input || '').trim().replace(/^['"]|['"]$/g, '')
  if (/^pan\.quark\.cn\/s\//i.test(trimmed)) {
    return `https://${trimmed}`
  }
  return trimmed
}

function isQuarkShareUrl(input: string) {
  const value = normalizePotentialQuarkUrl(input)
  try {
    const url = new URL(value)
    return /^pan\.quark\.cn$/i.test(url.hostname) && /^\/s\/[^/?#]+/.test(url.pathname)
  } catch {
    return false
  }
}

export const quarkProvider: Provider = {
  id: 'quark',
  name: 'Quark',
  match(input) {
    return isQuarkShareUrl(input)
  },
  async resolveShare(input) {
    // V0.6 first-stage Provider wrapper: Quark services/adapters remain the runtime implementation.
    return getShareFiles(input.shareUrl, input.passcode)
  },
  async list(input) {
    // V0.6 first-stage Provider wrapper: list logic still lives in server/services/quark/*.
    return listQuarkFiles(input.shareId, input.stoken, input.dirFid)
  },
  async getDownload(input) {
    // V0.6 first-stage Provider wrapper: quarkApi still owns tokens, cookies, QR sessions, and links.
    return getQuarkDownloadUrl(input.shareId, input.stoken, input.file, input.sessionId)
  }
}
