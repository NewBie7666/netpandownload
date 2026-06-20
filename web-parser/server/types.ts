export type WebProviderId = 'quark' | 'bilibili'
export type WebFileType = 'file' | 'folder' | 'episode'
export type WebFileStatus = 'available' | 'temporary' | 'restricted' | 'blocked'
export type WebUrlType = 'none' | 'temporary' | 'requires_cookie' | 'requires_login' | 'blocked'

export interface WebParsedFile {
  id: string
  name: string
  type: WebFileType
  size?: number
  status: WebFileStatus
  hint: string
  urlType: WebUrlType
}

export interface WebParseResult {
  providerId: WebProviderId
  title?: string
  mode: 'PURE_PARSER'
  files: WebParsedFile[]
  warnings: string[]
}
