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

export type ProviderId = 'quark' | 'bilibili'

export interface ProviderShareResult {
  providerId: ProviderId
  share: ShareResult
}

export interface ProviderListResult {
  providerId: ProviderId
  list: ListResult
}

export interface ProviderDownloadResult {
  providerId: ProviderId
  download: DownloadResult
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

export interface ProviderDebugResult {
  registered: string[]
  matchedInput?: string
  matchedProvider?: string
  lastResolveStatus?: 'ok' | 'error'
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

export type UnifiedTaskStatus =
  | 'queued'
  | 'pending'
  | 'running'
  | 'paused'
  | 'done'
  | 'error'
  | 'removed'

export interface UnifiedTask {
  id: string
  title: string
  providerId: ProviderId | 'unknown'
  status: UnifiedTaskStatus
  progress?: number
  source: 'engine' | 'aria2'
  createdAt: number
  gid?: string
  sourceUrl?: string
  downloadUrl?: string
  error?: string
  traceId?: string
  health?: 'stable' | 'degraded' | 'unstable'
  diagnosis?: {
    rootCause: string
    explanation: string
    suggestedAction: string
    recoverable: boolean
    health: 'stable' | 'degraded' | 'unstable'
  }
}

export interface ProductTasksResult {
  tasks: UnifiedTask[]
}

export interface DownloadDashboard {
  totalTasks: number
  runningCount: number
  pausedCount: number
  completedCount: number
  failedCount: number
  removedCount: number
  activeDownloads: number
}

export interface DownloadHistoryResult {
  items: UnifiedTask[]
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
