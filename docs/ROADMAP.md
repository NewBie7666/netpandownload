# ROADMAP

## V0.3.x - Web MVP Closing

### Goal
Stabilize the `Web + Local Express` Quark MVP around parsing, QR login, link resolution, proxy download, and mock-mode validation.

### Not in Scope
- No Bilibili provider
- No ffmpeg merge workflow
- No provider abstraction migration

### Acceptance Criteria
- Quark share parsing works through existing `/api/quark/*`
- QR login remains usable for supported cases
- Small-file direct links and large-file proxy download remain available
- Mock mode remains usable for local validation
- `npm run build` passes

## V0.4 - Electron Desktop Shell

### Goal
Wrap the existing local app in an Electron shell without replacing the Vue renderer or local Express backend.

### Not in Scope
- No Bilibili
- No provider abstraction migration
- No downloader rewrite

### Acceptance Criteria
- Desktop window can be launched by double-clicking the packaged app
- Local Express starts automatically with the desktop shell
- Existing Quark features remain available in the desktop window
- Closing the app window releases the local backend process cleanly

## V0.5 - Embedded aria2 Downloader

### Goal
Introduce aria2 JSON-RPC control for multithreaded local downloads and basic task management.

### Not in Scope
- No Bilibili provider
- No full provider abstraction rewrite
- No ffmpeg merge workflow
- No auto-update
- No installer distribution

### Acceptance Criteria
- Electron starts aria2 as a local sidecar when `aria2c.exe` is present
- The backend exposes local download task APIs under `/api/downloads/*`
- The backend exposes downloader health at `/api/downloads/health`
- Existing Quark download results can be handed to aria2 without changing `/api/quark/*`
- Basic task lifecycle is visible: active, waiting, paused, error, complete, removed
- Users can configure the default download directory
- Removing a task can either keep or delete the local file, with backend path safety checks
- The app remains usable when `aria2c.exe` is missing
- Source code does not commit `aria2c.exe`; release builds can include it when prepared before packaging

## V0.6 - Provider Architecture

### Goal
Abstract Quark-specific logic behind a Provider boundary so multiple content sources can share the same local backend and downloader workflow.

### Not in Scope
- No Bilibili implementation yet
- No ffmpeg pipeline

### Acceptance Criteria
- A Provider contract exists for matching and resolving resources
- Current Quark capability is represented through the new Provider boundary
- Existing user-visible Quark behavior remains functionally compatible

## V0.7 - Bilibili Provider

### Goal
Add a Bilibili provider on top of the Provider system.

### Not in Scope
- No DRM bypass
- No payment bypass
- No membership bypass
- No region restriction bypass
- No bulk redistribution tool positioning

### Acceptance Criteria
- Provider can identify supported Bilibili inputs
- Provider only assists with content the user already has rights to access
- The implementation does not introduce bypass behavior for paid, member-only, DRM-protected, or region-locked content

## V0.8 - ffmpeg Merge and Download Task Enhancements

### Goal
Add optional ffmpeg-based merge capabilities and improve the local download task model.

### Not in Scope
- No platform expansion beyond the supported providers already implemented

### Acceptance Criteria
- Audio/video merge can be triggered where applicable
- Task records support richer status and error states
- Retry, local task history, and download-management UX are improved

## Compliance Boundary for Future Bilibili Work

- Only handle content the user is authorized to access
- Do not implement paid-content bypass
- Do not implement membership bypass
- Do not implement region restriction bypass
- Do not implement DRM bypass
- Do not position the project as a bulk redistribution tool
