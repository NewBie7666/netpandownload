// URL observation alone never starts a download.
const EXTENSIONS = new Set([
  'pkg', 'json', 'xml', 'zip', '7z', 'rar', 'pdf', 'exe', 'msi',
  'iso', 'img', 'bin', 'tar', 'gz', 'bz2', 'xz', 'dmg', 'apk',
  'mp4', 'mkv', 'avi', 'webm', 'mov', 'mp3', 'flac', 'wav',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'torrent'
])
export function isDownloadCandidateUrl(input: unknown): input is string {
  if (typeof input !== 'string' || !input || input.length > 8192) return false
  try {
    const u = new URL(input)
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false
    const name = u.pathname.split('/').pop() || ''
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    return EXTENSIONS.has(extension)
  } catch {
    return false
  }
}
