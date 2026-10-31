/** Video source catalog is independent of the existing Quark/Bilibili Provider API. */
export interface VideoSource {
  id: string
  name: string
  apiUrl: string
  enabled: boolean
  type: 'maccms'
}
export interface VideoEpisode {
  label: string
  url: string
  kind: 'mp4' | 'hls' | 'unsupported'
}
export interface VideoPlayLine {
  name: string
  episodes: VideoEpisode[]
}
export interface VideoItem {
  id: string
  title: string
  cover?: string
  remarks?: string
  description?: string
  lines: VideoPlayLine[]
}
export interface VideoSearchResult {
  sourceId: string
  keyword: string
  items: VideoItem[]
  page: number
  pageCount: number
}
export interface VideoSourceImportResult {
  imported: number
  skipped: number
  sources: VideoSource[]
}
