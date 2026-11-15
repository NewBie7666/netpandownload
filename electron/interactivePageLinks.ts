import { identifyFileLink } from '../shared/fileLinkDiscovery.js'

export interface BrowserScanLink {
  url: string
  fileName: string
  extension: string
}

export interface BrowserScanResult {
  pageUrl: string
  extensions: string[]
  items: BrowserScanLink[]
  truncated: boolean
  domCandidates?: number
  networkCandidates?: number
}

export function parseBrowserExtensions(input: unknown): string[] {
  if (input === undefined || input === null || input === '') return []
  if (typeof input !== 'string' || input.length > 240) throw new Error('请输入文件后缀，例如 pkg,json,zip')
  const items = input.toLowerCase().split(/[,，;\s]+/).map(s => s.replace(/^\./, '').trim()).filter(Boolean)
  if (items.length > 20 || items.some(s => !/^[a-z0-9]{1,12}$/.test(s))) {
    throw new Error('文件后缀格式错误（最多 20 个）')
  }
  return [...new Set(items)]
}

export function browserFileLinks(
  pageUrl: string,
  candidateUrls: string[],
  extensions: string[] = [],
  maxItems = 200
): BrowserScanResult {
  const items: BrowserScanLink[] = []
  const seen = new Set<string>()
  const suffixes = new Set(extensions)
  let truncated = false
  for (const raw of candidateUrls.slice(0, 5000)) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 8192) continue
    let url: URL
    try {
      url = new URL(raw, pageUrl)
    } catch { continue }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) continue
    url.hash = ''
    const value = url.toString()
    if (seen.has(value)) continue
    const file = identifyFileLink(value)
    if (!file || (suffixes.size && !suffixes.has(file.extension))) continue
    seen.add(value)
    if (items.length >= maxItems) {
      truncated = true
      break
    }
    items.push(file)
  }
  return { pageUrl, extensions, items, truncated }
}
