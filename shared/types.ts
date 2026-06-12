export interface QuarkFile {
  fid: string
  name: string
  size: number
  isDir: boolean
  createdAt: string
}

export interface ApiResponse<T> {
  ok: boolean
  result?: T
  error?: string
  message?: string
}

export interface ShareResult {
  shareId: string
  stoken: string
  path: Array<{ fid: string; name: string }>
  files: QuarkFile[]
}

export interface ListResult {
  files: QuarkFile[]
}

export interface DownloadResult {
  fid: string
  name: string
  downloadUrl?: string
  downloadToken?: string
  proxyUrl?: string
  source: 'direct' | 'saved' | 'proxy'
  expiresAt: string
  cached: boolean
}

export type DownloadTaskStatus =
  | 'active'
  | 'waiting'
  | 'paused'
  | 'error'
  | 'complete'
  | 'removed'

export interface DownloadTask {
  gid: string
  fileName: string
  status: DownloadTaskStatus
  totalLength: number
  completedLength: number
  downloadSpeed: number
  progress: number
  dir?: string
}

export interface DownloadTasksResult {
  enabled: boolean
  message?: string
  defaultDir: string
  tasks: DownloadTask[]
}

export interface DownloadHealthResult {
  enabled: boolean
  message?: string
  defaultDir: string
}

export interface DownloadSettingsResult {
  downloadDir: string
  defaultDownloadDir: string
}

export interface AddDownloadRequest {
  url: string
  fileName?: string
  dir?: string
}

export interface AddDownloadResult {
  gid: string
}

export interface RemoveDownloadRequest {
  deleteFile?: boolean
}

export interface OpenDownloadDirResult {
  dir: string
}

export interface QuarkAuthQrcodeResult {
  sessionId: string
  qrImageUrl: string
  qrLoginUrl: string
  expiresAt: string
}

export type QuarkAuthStatus = 'waiting' | 'confirmed' | 'expired' | 'failed' | 'logged_in'

export interface QuarkAuthStatusResult {
  sessionId: string
  status: QuarkAuthStatus
  message: string
  expiresAt?: string
}
