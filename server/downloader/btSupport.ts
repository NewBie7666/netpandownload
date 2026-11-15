/**
 * Public tracker bootstrap is supplementary to announce URLs in the magnet.
 * These trackers see the infohash. Never send private torrents to them.
 * Source: https://github.com/ngosang/trackerslist (2026-11-16).
 */
export const PUBLIC_BT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.tracker.cl:1337/announce',
  'http://tracker.opentrackr.org:1337/announce'
]

function base32ToHex(encoded: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let accumulator = 0
  let bits = 0
  const bytes: number[] = []
  for (const character of encoded.toUpperCase()) {
    const index = alphabet.indexOf(character)
    if (index < 0) return ''
    accumulator = (accumulator << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >> bits) & 255)
      accumulator &= (1 << bits) - 1
    }
  }
  return bytes.length === 20 ? Buffer.from(bytes).toString('hex') : ''
}

export function normalizeBtih(value: string): string {
  const raw = value.trim()
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase()
  if (/^[a-z2-7]{32}$/i.test(raw)) return base32ToHex(raw)
  return ''
}

export function infoHashFromMagnet(uri: string): string {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol !== 'magnet:') return ''
    const xt = parsed.searchParams.get('xt') || ''
    const match = xt.match(/^urn:btih:(.+)$/i)
    return match ? normalizeBtih(match[1]) : ''
  } catch { return '' }
}

export function btDownloadOptions(dir: string): Record<string, string> {
  return {
    dir,
    'bt-save-metadata': 'true',
    'bt-metadata-only': 'false',
    'seed-time': '0',
    'bt-tracker': PUBLIC_BT_TRACKERS.join(','),
    'bt-tracker-connect-timeout': '20',
    'bt-tracker-timeout': '35'
  }
}

export function metadataDiagnostic(seconds: number, connections: number, seeds: number): string {
  if (seconds >= 600 && connections === 0) {
    return '等待元数据超过10分钟，仍未连接BT节点。检查UDP/DHT网络或将同一磁力与qBittorrent对照；任务不会自动删除。'
  }
  if (seconds >= 180 && connections === 0) {
    return '仍在发现BT节点，当前连接数为0。已启用DHT、PeX和公共Tracker；请检查本机UDP、代理或防火墙。'
  }
  if (seconds >= 180 && connections > 0) {
    return '已连接' + connections + '个节点（做种者' + seeds + '个），但元数据尚未下载完成。'
  }
  return '正在获取Torrent元数据；尚未开始下载实际文件。'
}
