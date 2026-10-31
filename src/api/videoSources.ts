import type { VideoItem, VideoSearchResult, VideoSource, VideoSourceImportResult } from '../../shared/videoSources'

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/video-sources' + path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  const data = await response.json() as { ok: boolean, result?: T, message?: string, error?: string }
  if (!response.ok || !data.ok || data.result === undefined) {
    throw new Error(data.message || data.error || '影视源操作失败')
  }
  return data.result
}

const query = (values: Record<string, string | number>) => '?' + new URLSearchParams(
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]))
).toString()

export const listVideoSources = () => request<VideoSource[]>('/sources')
export const addVideoSource = (name: string, apiUrl: string) => request<VideoSource>('/sources', 'POST', { name, apiUrl, type: 'maccms' })
export const removeVideoSource = (id: string) => request<{ id: string }>('/sources/' + encodeURIComponent(id), 'DELETE')
export const setVideoSourceEnabled = (id: string, enabled: boolean) =>
  request<VideoSource>('/sources/' + encodeURIComponent(id), 'PATCH', { enabled })
export const importTvBoxConfig = (config: string) => request<VideoSourceImportResult>('/import-tvbox', 'POST', { config })
export const testVideoSource = (sourceId: string) => request<{ sourceId: string, ok: boolean, sampleCount: number }>('/test' + query({ sourceId }))
export const searchVideoSource = (sourceId: string, keyword: string, page = 1) =>
  request<VideoSearchResult>('/search' + query({ sourceId, keyword, page }))
export const detailVideoSource = (sourceId: string, videoId: string) =>
  request<VideoItem>('/detail' + query({ sourceId, videoId }))
export const downloadVideoEpisode = (sourceId: string, videoId: string, lineIndex: number, episodeIndex: number) =>
  request<{ gid: string, fileName: string }>('/download', 'POST', { sourceId, videoId, lineIndex, episodeIndex })
