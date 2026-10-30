import { isIP } from 'node:net'
import { AppError } from '../http.js'

// Accept only BT v1 magnet hashes. Never pass arbitrary aria2 URI schemes or
// unbounded tracker lists from the private-web API into the RPC engine.
const hashPattern = /^(?:[a-f\d]{40}|[a-z2-7]{32})$/i
const privateIpv4 = (host: string) => {
  const bytes = host.split('.').map(Number)
  const [a, b] = bytes
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 255)
}

function validateTracker(value: string): string {
  if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError('invalid_magnet', 'Tracker 地址过长或含非法字符')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError('invalid_magnet', 'Tracker 地址格式无效')
  }
  if (!['https:', 'http:', 'udp:'].includes(url.protocol) ||
    !url.hostname || url.username || url.password || url.hash) {
    throw new AppError('invalid_magnet', 'Tracker 只允许不含凭据的 HTTP/HTTPS/UDP 地址')
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (isIP(host) === 6 || host.startsWith('[') || (isIP(host) === 4 && privateIpv4(host)) ||
    host === 'localhost' || !host.includes('.') ||
    /\.(?:localhost|local|lan|internal|test|invalid|example)$/.test(host)) {
    throw new AppError('invalid_magnet', 'Tracker 不允许使用本机或内网地址')
  }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw new AppError('invalid_magnet', 'Tracker 端口无效')
  }
  return url.toString()
}

export function validateMagnetInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof (input as { magnet?: unknown }).magnet !== 'string') {
    throw new AppError('invalid_magnet', '请输入磁力链接')
  }
  const raw = (input as { magnet: string }).magnet.trim()
  if (raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new AppError('invalid_magnet', '磁力链接过长或包含非法字符')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppError('invalid_magnet', '磁力链接格式错误')
  }
  if (url.protocol !== 'magnet:' || url.pathname || url.host || url.hash || !raw.startsWith('magnet:?')) {
    throw new AppError('invalid_magnet', '仅接受 magnet:?xt=urn:btih:... 格式')
  }
  const xts = url.searchParams.getAll('xt')
  const hash = xts.length === 1 ? /^urn:btih:(.+)$/i.exec(xts[0])?.[1] : undefined
  if (!hash || !hashPattern.test(hash)) {
    throw new AppError('invalid_magnet', '磁力链接必须包含有效的 BTIH（40位十六进制或32位Base32）')
  }
  const names = url.searchParams.getAll('dn')
  if (names.length > 1 || (names[0] && (names[0].length > 200 || /[\u0000-\u001f\u007f]/.test(names[0])))) {
    throw new AppError('invalid_magnet', '资源名称不合法')
  }
  const trackers = url.searchParams.getAll('tr')
  if (trackers.length > 20) throw new AppError('invalid_magnet', 'Tracker 数量不能超过20个')
  const params = new URLSearchParams()
  params.set('xt', 'urn:btih:' + hash.toLowerCase())
  if (names[0]) params.set('dn', names[0])
  for (const tracker of new Set(trackers.map(validateTracker))) params.append('tr', tracker)
  return 'magnet:?' + params.toString()
}
