import type { PageFileLink } from './types.js'

// URLs are candidates only: selecting a type never triggers a download.
export const OTHER_EXTENSION = 'other'
const WEB_PAGE_EXTENSIONS = new Set(['html','htm','php','asp','aspx','jsp','jspx','js','css','map'])
const DOWNLOAD_PATH = /\/(?:download|downloads|attachment|attachments|getfile|file-download)(?:\/|$)/i

export function identifyFileLink(raw: string, explicit = false): PageFileLink | null {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null
  url.hash = ''
  let fileName: string
  try { fileName = decodeURIComponent(url.pathname.split('/').pop() || '') } catch { return null }
  const queryFile = ['filename','file','name','attachment']
    .map(key => url.searchParams.get(key))
    .find(value => value && value.length <= 180 && value.includes('.'))
  if (queryFile && (!fileName || !fileName.includes('.'))) fileName = queryFile
  if (/[/\\\x00-\x1f\x7f]/.test(fileName)) return null
  const dot = fileName.lastIndexOf('.')
  const extension = dot > 0 && /^[a-z0-9]{1,12}$/i.test(fileName.slice(dot+1))
    ? fileName.slice(dot+1).toLowerCase() : ''
  if (extension && WEB_PAGE_EXTENSIONS.has(extension)) return null
  if (!extension && !(explicit || DOWNLOAD_PATH.test(url.pathname))) return null
  return { url:url.toString(), fileName:fileName||'未命名下载', extension:extension||OTHER_EXTENSION }
}

export interface FileTypeGroup { extension: string; count: number }
export function groupFileExtensions(items: Pick<PageFileLink,'extension'>[]): FileTypeGroup[] {
  const counts = new Map<string,number>()
  for (const item of items) {
    const ext = item.extension.toLowerCase() || OTHER_EXTENSION
    counts.set(ext,(counts.get(ext)||0)+1)
  }
  return [...counts].map(([extension,count])=>({extension,count}))
    .sort((a,b)=>b.count-a.count || a.extension.localeCompare(b.extension))
}
export function filterFileLinks<T extends PageFileLink>(items:T[], visibleTypes:string[]): T[] {
  const visible = new Set(visibleTypes)
  return items.filter(item=>visible.has(item.extension.toLowerCase()||OTHER_EXTENSION))
}
