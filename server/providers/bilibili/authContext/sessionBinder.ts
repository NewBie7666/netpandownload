import { normalizeBiliUrl } from '../resolver/index.js'
import { buildAuthContext, type AuthContext } from './contextBuilder.js'

const contexts = new Map<string, AuthContext>()

export function bindEpisodeAuthContext(episodeUrl: string): AuthContext {
  const normalizedUrl = normalizeBiliUrl(String(episodeUrl || '').trim())
  const existing = contexts.get(normalizedUrl)
  if (existing) {
    return existing
  }

  const context = buildAuthContext(normalizedUrl)
  contexts.set(normalizedUrl, context)
  return context
}

export async function waitForAuthTiming(context: AuthContext) {
  if (context.timingDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, context.timingDelayMs))
  }
}
