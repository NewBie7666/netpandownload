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
}

export function parseBrowserExtensions(input: unknown): string[] {
  if (typeof input !== 'string' || input.length > 240) throw new Error('请输入文件后缀，例如 pkg,json,zip')
  const items = input.toLowerCase().split(/[,，;\s]+/).map(s => s.replace(/^\./, '').trim()).filter(Boolean)
  if (!items.length || items.length > 20 || items.some(s => !/^[a-z0-9]{1,12}$/.test(s))) {
    throw new Error('文件后缀格式错误（最多 20 个）')
  }
  return [...new Set(items)]
}

export function browserFileLinks(
  pageUrl: string,
  candidateUrls: string[],
  extensions: string[],
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
    let fileName: string
    try {
      fileName = decodeURIComponent(url.pathname.split('/').pop() || '')
    } catch { continue }
    if (!fileName || /[/\\\x00-\x1f]/.test(fileName)) continue
    const dot = fileName.lastIndexOf('.')
    const extension = dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase()
    if (!suffixes.has(extension)) continue
    seen.add(value)
    if (items.length >= maxItems) {
      truncated = true
      break
    }
    items.push({ url: value, fileName, extension })
  }
  return { pageUrl, extensions, items, truncated }
}
