# Quark Download MVP

Current versions of this project run as a local Quark MVP with both:

- `Web + Local Express` development mode
- `Electron + Local Express` desktop-shell mode

The long-term product direction is a **local desktop download client**. The minimal Electron shell and embedded aria2 downloader integration are now included, but **Bilibili provider support, ffmpeg integration, and Provider abstraction are still not implemented**.

## Current State

- Frontend: `Vite + Vue + TypeScript`
- Backend: `Express + TypeScript`
- Desktop shell: `Electron`
- Current API surface stays under `/api/quark/*`
- Supports:
  - Quark share parsing
  - File listing
  - Folder navigation
  - QR login session flow
  - Download link resolution
  - Save-to-drive fallback for restricted cases
  - Proxy download for large files
  - Embedded aria2 task control in the desktop client
  - Mock mode for local validation

## Long-Term Direction

The target architecture is:

```text
Electron shell
+ Vue renderer
+ Local Express backend
+ Provider system
+ Downloader engine
+ optional ffmpeg
```

This direction is not fully implemented in the current version. The current project should still be treated as a local MVP for validating the Quark workflow.

## Development Scripts

```bash
npm install
npm run dev
npm run dev:client
npm run dev:server
npm run dev:desktop
npm run electron:dev
npm run build
npm run build:desktop
npm run dist:win
```

- `npm run dev`: starts frontend and backend together
- `npm run dev:client`: starts Vite only
- `npm run dev:server`: starts Express only
- `npm run dev:desktop`: starts Vite and launches the Electron shell, which manages the local backend process
- `npm run electron:dev`: alias for the desktop development mode
- `npm run build`: builds frontend and backend
- `npm run build:desktop`: builds frontend, backend, Electron main process, and creates a Windows portable package
- `npm run dist:win`: alias for the Windows portable packaging flow

Vite development requests under `/api` are proxied to the local Express backend.

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed:

```env
PORT=3000
QUARK_COOKIE=
QUARK_UA=
QUARK_REFERER=
QUARK_DOWNLOAD_CACHE_TTL_SECONDS=600
QUARK_MOCK=false
```

- `QUARK_MOCK=true`: uses stable mock data for local UI and API validation
- `QUARK_MOCK=false`: uses the current Quark integration path
- `QUARK_COOKIE`, `QUARK_UA`, and `QUARK_REFERER` remain server-side only

## Embedded Downloader

- The desktop client can use embedded `aria2` for multithreaded local downloads
- `aria2c.exe` must exist at `resources/aria2/win/aria2c.exe`
- Default download directory: `Downloads/QuarkDownloads`
- If `aria2c.exe` is missing:
  - Quark parsing still works
  - Browser download still works
  - The built-in downloader is shown as unavailable
- Large files are better suited to the built-in downloader than normal browser download

## Current Boundaries

- This does **not** include Bilibili support
- This does **not** include ffmpeg merging
- This does **not** change existing `/api/quark/*` routes

## Project Docs

- [Roadmap](docs/ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Decisions](docs/DECISIONS.md)

## Compatibility Notes

- Existing Quark code remains in `server/services/quark/*` and `server/adapters/quarkApi.ts`
- Provider abstraction is a future step, not part of the current runtime
- Current download behavior supports both browser delivery and embedded aria2 delivery
- Electron manages the local desktop shell, backend lifecycle, and aria2 sidecar lifecycle
