/** Chromium proxy decision format: "PROXY 127.0.0.1:7890; DIRECT". 
 * Only loopback HTTP proxies are accepted, to avoid arbitrary network pivots.
 */
export type SourceRoute = { kind: 'direct' } | { kind: 'proxy', host: '127.0.0.1' | '::1', port: number }

export function parseSourceProxyRoutes(reply: string): SourceRoute[] {
  const routes: SourceRoute[] = []
  for (const piece of String(reply || 'DIRECT').split(';').map(v => v.trim()).filter(Boolean)) {
    if (piece.toUpperCase() === 'DIRECT') {
      routes.push({ kind: 'direct' })
      continue
    }
    const match = /^PROXY\s+(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/i.exec(piece)
    if (!match) continue
    const rawHost = match[1].replace(/^\[|\]$/g, '').toLowerCase()
    const host = rawHost === 'localhost' || rawHost === '127.0.0.1' ? '127.0.0.1'
      : rawHost === '::1' ? '::1' : null
    const port = Number(match[2])
    if (host && port > 0 && port < 65536) routes.push({ kind: 'proxy', host, port })
  }
  // Do not bypass explicit SOCKS/enterprise proxy policies by silently using DIRECT.
  if (!routes.length) throw new Error('系统代理配置使用了不支持的 SOCKS/远程代理或无效格式；请启用本机 HTTP 系统代理')
  return routes
}

export function preferIpv4<T extends { family: number }>(addresses: T[]): T[] {
  return [...addresses].sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1))
}
