import type { ProviderId } from '../../shared/types.js'

export type EngineTaskStatus =
  | 'queued'
  | 'pending'
  | 'running'
  | 'paused'
  | 'done'
  | 'error'
  | 'removed'

export type EngineTaskAction = 'pause' | 'resume' | 'remove'

export interface DownloadEngineAddRequest {
  providerId: ProviderId
  sourceUrl: string
  episodeId: string
  fileName: string
  downloadUrl?: string
  proxyUrl?: string
}

export interface DownloadEngineTask {
  id: string
  providerId: ProviderId
  sourceUrl: string
  episodeId: string
  fileName: string
  downloadUrl: string
  status: EngineTaskStatus
  createdAt: number
  updatedAt: number
  lastUpdated: number
  persisted: boolean
  gid?: string
  error?: string
}

export interface DownloadEngineEvent {
  taskId: string
  action: string
  fromState: EngineTaskStatus
  toState: EngineTaskStatus
  timestamp: number
}

export interface DownloadEngineListResult {
  tasks: DownloadEngineTask[]
  events: DownloadEngineEvent[]
  maxConcurrent: number
}

export interface DownloadEngineAddResult {
  id: string
  status: EngineTaskStatus
}

export interface DownloadEngineActionRequest {
  id: string
  action: EngineTaskAction
}

export interface DownloadEngineActionResult {
  id: string
  status: EngineTaskStatus
}
