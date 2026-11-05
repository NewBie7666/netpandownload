import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export interface DesktopRuntimeStatus {
  ffmpeg: boolean
  ffprobe: boolean
  aria2: boolean
  ytDlp: boolean
  galleryDl: boolean
  ffmpegPath: string
  ytDlpPath: string
  galleryDlPath: string
}

function executableWorks(candidate: string, arg = '-version'): boolean {
  if (path.isAbsolute(candidate) && !existsSync(candidate)) return false
  const result = spawnSync(candidate, [arg], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 6000
  })
  return !result.error && result.status === 0
}

function resolveBinary(name: string, resourcesPath: string, appRoot: string, folder: string, arg = '-version') {
  const candidates = [
    path.join(resourcesPath, folder, 'win', name),
    path.join(appRoot, 'resources', folder, 'win', name)
  ]
  for (const candidate of candidates) {
    if (executableWorks(candidate, arg)) return candidate
  }
  // Development builds may use an explicitly installed system utility.
  if (executableWorks(name, arg)) return name
  return ''
}

export function configureDesktopRuntime(resourcesPath: string, appRoot: string): DesktopRuntimeStatus {
  const ffmpegPath = resolveBinary('ffmpeg.exe', resourcesPath, appRoot, 'ffmpeg')
  const ffprobePath = resolveBinary('ffprobe.exe', resourcesPath, appRoot, 'ffmpeg')
  const ytDlpPath = resolveBinary('yt-dlp.exe', resourcesPath, appRoot, 'yt-dlp', '--version')
  const aria2Path = resolveBinary('aria2c.exe', resourcesPath, appRoot, 'aria2', '--version')
  const galleryDlPath = resolveBinary('gallery-dl.exe', resourcesPath, appRoot, 'gallery-dl', '--version')
  if (ffmpegPath) process.env.NETPAN_FFMPEG_PATH = ffmpegPath
  if (ytDlpPath) process.env.YTDLP_PATH = ytDlpPath
  if (galleryDlPath) process.env.GALLERY_DL_PATH = galleryDlPath
  return {
    ffmpeg: Boolean(ffmpegPath),
    ffprobe: Boolean(ffprobePath),
    aria2: Boolean(aria2Path),
    ytDlp: Boolean(ytDlpPath),
    galleryDl: Boolean(galleryDlPath),
    ffmpegPath,
    ytDlpPath,
    galleryDlPath
  }
}

export function desktopRuntimeWarnings(status: DesktopRuntimeStatus): string[] {
  const missing: string[] = []
  if (!status.aria2) missing.push('aria2：HTTP/磁力及网盘下载引擎不可用')
  if (!status.ffmpeg || !status.ffprobe) missing.push('FFmpeg/FFprobe：HLS 视频合并不可用')
  if (!status.ytDlp) missing.push('yt-dlp：部分视频平台解析不可用')
  if (!status.galleryDl) missing.push('gallery-dl：Instagram 下载不可用')
  return missing
}
