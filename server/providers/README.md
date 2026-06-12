# Providers

This directory contains the V0.6 Provider boundary.

Current status:

- Provider registry is enabled
- Quark and Bilibili are registered Providers
- `/api/providers/resolve`, `/api/providers/list`, and `/api/providers/download` are the main Provider entry points
- `/api/quark/*` remains as a compatibility API
- Current Quark logic still lives in `server/services/quark/*`
- Current Quark adapter still lives in `server/adapters/quarkApi.ts`
- V0.6 wraps Quark behavior without fully migrating adapter internals
- V0.8 Bilibili uses `yt-dlp.exe` for public-resource parsing when available
- Bilibili keeps mock fallback when `yt-dlp.exe` is missing or parsing fails

Provider responsibility:

- Match an input link or source
- Resolve a share into normalized files
- List provider folders
- Return provider download results
- Normalize source-specific behavior behind a common boundary

API wrappers:

- `resolve` wraps `ShareResult` as `{ providerId, share }`
- `list` wraps `ListResult` as `{ providerId, list }`
- `download` wraps `DownloadResult` as `{ providerId, download }`

Current code contract:

```ts
interface Provider {
  id: string
  name: string
  match(input: string): boolean
  resolveShare(input: ResolveShareInput): Promise<ShareResult>
  list(input: ListInput): Promise<ListResult>
  getDownload(input: DownloadInput): Promise<DownloadResult>
}
```

`match(input)` must be source-specific and conservative. The Quark Provider only matches Quark share links. The Bilibili Provider only matches known Bilibili URL shapes, calls local `yt-dlp.exe` for public resources, and does not implement member/paid/region/DRM bypass behavior.
