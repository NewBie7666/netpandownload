# Providers

This directory contains the V0.6 Provider boundary.

Current status:

- Provider registry is enabled
- Quark is the only registered Provider
- Current Quark logic still lives in `server/services/quark/*`
- Current Quark adapter still lives in `server/adapters/quarkApi.ts`
- V0.6 wraps Quark behavior without fully migrating adapter internals

Provider responsibility:

- Match an input link or source
- Resolve a share into normalized files
- List provider folders
- Return provider download results
- Normalize source-specific behavior behind a common boundary

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

`match(input)` must be source-specific and conservative. The Quark Provider only matches Quark share links. Future Bilibili matching must use its own rules.
