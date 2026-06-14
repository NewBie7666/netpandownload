import type {
  DownloadResult,
  ListResult,
  QuarkFile,
  ShareResult
} from '../../shared/types.js'

export type ProviderId = 'quark' | 'bilibili'
export type ProviderSource = 'real' | 'mock' | 'fallback' | 'cache'
export type ProviderStatus = 'ok' | 'error'
export type ProviderResultKind = 'success' | 'error' | 'fallback'
export type ProviderErrorCode =
  | 'unsupported_provider'
  | 'parse_failed'
  | 'restricted'
  | 'dependency_missing'
  | 'network_error'
  | 'dash_unsupported'
  | 'auth_required'
  | 'blocked_by_upstream'

export interface ProviderError {
  code: ProviderErrorCode
  message: string
  recoverable: boolean
}

export interface ProviderMeta {
  source?: ProviderSource
  reason?: string
  providerMeta?: unknown
}

export interface ProviderSuccessResponse<T> {
  kind: 'success'
  ok: true
  providerId: ProviderId
  data: T
  meta?: ProviderMeta
}

export interface ProviderErrorResponse {
  kind: 'error'
  ok: false
  providerId: ProviderId
  data?: null
  error: ProviderError
  meta?: ProviderMeta
}

export interface FallbackProviderResponse {
  kind: 'fallback'
  ok: false
  providerId: ProviderId
  data: null
  error: ProviderError
  meta: ProviderMeta & {
    source: 'fallback'
    reason: string
  }
}

export type ProviderResponse<T> =
  | ProviderSuccessResponse<T>
  | ProviderErrorResponse
  | FallbackProviderResponse

export interface ProviderCapabilities {
  list: boolean
  download: boolean
  login: boolean
  streaming: boolean
}

export interface ResolveShareInput {
  shareUrl: string
  passcode?: string
}

export interface ListInput {
  shareId: string
  stoken: string
  dirFid?: string
}

export interface DownloadInput {
  shareId: string
  stoken: string
  file: QuarkFile
  sessionId?: string
}

export interface Provider {
  id: ProviderId
  name: string
  capabilities: ProviderCapabilities
  match(input: string): boolean
  resolveShare(input: ResolveShareInput): Promise<ProviderResponse<ShareResult>>
  list(input: ListInput): Promise<ProviderResponse<ListResult>>
  getDownload(input: DownloadInput): Promise<ProviderResponse<DownloadResult>>
}
