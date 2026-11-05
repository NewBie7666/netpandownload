import { fetchVideoSourceJson } from '../server/video-sources/network.js'
const urls = [
  ['HG TVBox JSON', 'https://api.hgyx.vip/hgyx.json'],
  ['Fantaiying redirect', 'http://www.饭太硬.net/tv']
] as const
for (const [label, url] of urls) {
  try {
    const data = await fetchVideoSourceJson(url)
    if (!data || typeof data !== 'object') throw Error('JSON was not an object')
    const raw = data as { sites?: Array<{ type?: number | string }> }
    const counts: Record<string, number> = {}
    for (const site of raw.sites || []) {
      const type = String(site?.type ?? 'unknown')
      counts[type] = (counts[type] || 0) + 1
    }
    console.log(label, 'OK', JSON.stringify({
      hasSites: Array.isArray(raw.sites),
      siteCount: raw.sites?.length || 0,
      typeCounts: counts
    }))
  } catch (error) {
    const value = error as { error?: string, code?: string, message?: string }
    console.log(label, 'ERROR', value.error || value.code || 'unknown', value.message || '')
  }
}
