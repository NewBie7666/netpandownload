# ARCHITECTURE

## Current Runtime Shape

The current project runs as a local desktop-capable MVP:

- `Electron shell` owns the desktop window and local process lifecycle.
- `Vue renderer` owns the user interface.
- `Local Express backend` remains the local API boundary.
- `Quark-specific services` stay under `server/services/quark/*`.
- `Quark adapter` stays under `server/adapters/quarkApi.ts`.
- `aria2` JSON-RPC control logic lives under `server/downloader/*`.
- Download settings are stored in `data/settings.json` for plain development mode and under Electron `userData` for desktop mode.

Electron shell and aria2 control logic are active. The aria2 sidecar starts only when `aria2c.exe` exists in the expected resource path.

Provider abstraction, Bilibili support, ffmpeg merge, auto-update, and installer distribution are still future work.

## Current Download Data Flow

Browser or proxy delivery:

```text
Quark CDN
  ↓
Local Express proxy
  ↓
Browser download
```

Desktop aria2 delivery when `aria2c.exe` is present:

```text
Quark download URL or local proxy URL
  ↓
Local Express /api/downloads/*
  ↓
aria2 sidecar over local JSON-RPC
  ↓
Local disk
```

Future provider-based flow:

```text
Quark / Bilibili CDN
  ↓
Local backend Provider
  ↓
Downloader engine / aria2
  ↓
Local disk
```

## Target Layers

### Electron shell
- Owns the desktop window, app lifecycle, packaging, and local process startup.
- Starts the local Express backend.
- Starts the aria2 sidecar when `aria2c.exe` is present.
- Provides a narrow preload/IPC bridge for desktop-only directory selection.
- Does not implement Quark business logic directly.

### Vue renderer
- Keeps the existing UI role for link input, file browsing, auth status, link resolution, and download task actions.
- Current UI remains a Chinese tool-style workflow, not a downloader dashboard rewrite.

### Local Express backend
- Owns parsing, session handling, Quark integration, download proxying, and local downloader coordination.
- Existing `/api/quark/*` endpoints remain the current Quark contract.
- `/api/downloads/*` endpoints expose local task control for the desktop downloader.

### Provider system
- Future abstraction layer for converting an input link into one or more downloadable resources.
- Current Quark code is not migrated yet.
- Bilibili is a future provider, not part of the current runtime.

### Downloader engine
- Current state: browser download, local proxy stream, or aria2 task delivery.
- Current V0.5 scope: aria2 sidecar with local JSON-RPC control, task polling, pause, resume, remove, open-dir support, configurable download directory, optional local file deletion, and `/api/downloads/health`.
- Binary availability: `aria2c.exe` is not committed to the source repository; it must be prepared at `resources/aria2/win/aria2c.exe` before development use or release packaging.
- Future state: richer task history, retry policy, and media post-processing.

### Download settings and file deletion
- `GET /api/downloads/settings` and `POST /api/downloads/settings` manage the effective download directory.
- Electron directory selection goes through preload IPC and `dialog.showOpenDialog`; the renderer does not get Node APIs.
- Local file deletion never accepts a frontend-provided path. The backend reads the aria2 task file path, verifies it is a regular file inside the configured or default download directory, deletes it if requested, then removes the aria2 task record.

## Quark Position in the Transition

- Current Quark code remains in `server/services/quark/*`.
- Current Quark adapter remains in `server/adapters/quarkApi.ts`.
- Current `/api/quark/*` routes remain unchanged.
- Provider migration is postponed until `V0.6`.

This avoids breaking the working MVP before the provider boundary is stable.

## Future Bilibili Position

Bilibili is planned as a future provider only after:

1. the desktop shell is stable
2. the downloader engine is stable
3. the provider abstraction is stable

Compliance boundary for future Bilibili work:

- Only support content the user is authorized to access.
- Do not implement paid-content bypass.
- Do not implement membership bypass.
- Do not implement region restriction bypass.
- Do not implement DRM bypass.
- Do not position the app as a bulk redistribution tool.

## Why the Current Code Stays in Place

The current MVP already has working Quark parsing and download logic. Moving it into a new provider abstraction now would increase regression risk without unlocking immediate user value.

The transition order stays:

1. stabilize Web MVP
2. add desktop shell
3. add downloader engine
4. introduce provider abstraction
5. add new providers
