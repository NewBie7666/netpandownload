import type {
  DownloadResult,
  ListResult,
  QuarkFile,
  ShareResult
} from '../../shared/types.js'

export type ProviderId = 'quark'

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
  match(input: string): boolean
  resolveShare(input: ResolveShareInput): Promise<ShareResult>
  list(input: ListInput): Promise<ListResult>
  getDownload(input: DownloadInput): Promise<DownloadResult>
}
