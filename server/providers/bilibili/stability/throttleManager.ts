const globalCooldownMs = 200
const episodeCooldownMs = 2000

let nextGlobalAt = 0
const nextEpisodeAt = new Map<string, number>()

async function waitUntil(timestamp: number) {
  const delay = timestamp - Date.now()
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

export async function throttleBilibiliRequest(key?: string) {
  const now = Date.now()
  const episodeKey = key ? `episode:${key}` : ''
  const target = Math.max(nextGlobalAt, episodeKey ? nextEpisodeAt.get(episodeKey) || 0 : 0)
  await waitUntil(target)

  const updated = Date.now()
  nextGlobalAt = updated + globalCooldownMs
  if (episodeKey) {
    nextEpisodeAt.set(episodeKey, updated + episodeCooldownMs)
  }
}
