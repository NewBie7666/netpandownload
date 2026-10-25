import type { QuarkFile } from '../../../shared/types.js'

export type SocialPlatform = 'douyin' | 'xiaohongshu'
export interface SocialMedia {
  file: QuarkFile
  url: string
}
export interface SocialSource {
  platform: SocialPlatform
  url: string
  id?: string
}
export interface SocialPost {
  platform: SocialPlatform
  id: string
  sourceUrl: string
  media: SocialMedia[]
}
