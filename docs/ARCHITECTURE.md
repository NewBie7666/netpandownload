# ARCHITECTURE

## Current Runtime Shape

The current project runs as a local MVP:

- `Vue renderer` in the browser
- `Local Express backend` on the same machine
- `Quark-specific services` under `server/services/quark/*`
- `Quark adapter` under `server/adapters/quarkApi.ts`

No Provider system, Electron shell, aria2 engine, or Bilibili support is active yet.
The Electron shell is active in `V0.4`, but Provider abstraction, aria2, and Bilibili support are still future work.

## Current Web MVP Data Flow

```text
Quark CDN
  ↓
Local Express proxy
  ↓
Browser download
```

This is the flow used today for large-file delivery through the local proxy path.

## Future Desktop Client Data Flow

```text
Quark / Bilibili CDN
  ↓
Local backend Provider
  ↓
Downloader engine / aria2
  ↓
Local disk
```

This is the intended future flow after the desktop shell, provider layer, and embedded downloader are introduced.

## Target Layers

### Electron shell
- Owns the desktop window, app lifecycle, packaging, tray, and system integration
- Hosts the local renderer and coordinates backend startup
- Implemented as a minimal shell in the current version

### Vue renderer
- Keeps the existing UI role for link input, file browsing, auth status, and download actions
- Will later evolve into a desktop renderer without replacing the current frontend stack

### Local Express backend
- Remains the local API boundary
- Owns parsing, session handling, provider orchestration, and download coordination
- Existing `/api/quark/*` endpoints remain the current contract

### Provider system
- Future abstraction layer for converting an input link into one or more downloadable resources
- Quark will become the first real provider after the abstraction step
- Bilibili is a future provider, not part of the current runtime

### Downloader engine
- Current state: browser download, local proxy stream, or embedded aria2 task delivery
- Current V0.5 scope: aria2 sidecar with local JSON-RPC control, task polling, pause, resume, remove, and open-dir support
- Future state: richer task history, retry policy, save-directory selection, and media post-processing

## Quark Position in the Transition

- Current Quark code remains in `server/services/quark/*`
- Current Quark adapter remains in `server/adapters/quarkApi.ts`
- Current `/api/quark/*` routes remain unchanged
- Provider migration is postponed until `V0.6`

This avoids breaking the working MVP before the provider boundary is stable.

## Future Bilibili Position

Bilibili is planned as a future provider only after:

1. the desktop shell is in place
2. the downloader engine exists
3. the provider abstraction is stable

Compliance boundary for future Bilibili work:

- Only support content the user is authorized to access
- Do not implement paid-content bypass
- Do not implement membership bypass
- Do not implement region restriction bypass
- Do not implement DRM bypass
- Do not position the app as a bulk搬运 tool

## Why the Current Code Stays in Place

The current MVP already has working Quark parsing and download logic. Moving it into a new provider abstraction now would increase regression risk without unlocking immediate user value.

So the transition order stays:

1. stabilize Web MVP
2. add desktop shell
3. add downloader engine
4. introduce provider abstraction
5. add new providers
