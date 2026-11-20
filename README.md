# Quark Download MVP

Current versions of this project run as a local Quark MVP with both:

- `Web + Local Express` development mode
- `Electron + Local Express` desktop-shell mode

The long-term product direction is a **local desktop download client**. The Electron shell, local backend lifecycle, Provider registry, unified Provider API, Quark Provider wrapper, Bilibili Provider with `yt-dlp` sidecar support, aria2 RPC control path, download task APIs, and download task UI are now implemented. **Bilibili DASH merge, member/paid/region/DRM handling, auto-update, and installer distribution are still not implemented**.

## Current State

- Frontend: `Vite + Vue + TypeScript`
- Backend: `Express + TypeScript`
- Desktop shell: `Electron`
- The main resource flow now uses `/api/providers/*`
- Existing `/api/quark/*` routes remain as compatibility APIs
- Provider registry is enabled with Quark and Bilibili Providers
- Supports:
  - Quark share parsing
  - File listing
  - Folder navigation
  - QR login session flow
  - Download link resolution
  - Save-to-drive fallback for supported restricted files
  - Local proxy download for links that require login state
  - Optional aria2 delivery for local multithreaded downloads
  - Download task API and UI in the desktop client
  - Configurable download directory
  - Download task removal with optional local file deletion
  - Bilibili public-resource parsing through local `yt-dlp.exe` when available
  - Bilibili mock fallback when `yt-dlp.exe` is missing or parsing fails
  - Unified resource input for Quark share links and Bilibili video links
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


## X / Twitter public video support

- Paste a public post URL such as `https://x.com/example/status/1234567890123456789` (also accepts `twitter.com`, `www` and `mobile` hosts).
- The X Provider uses the bundled `yt-dlp.exe` (or `YTDLP_PATH`) to extract the tweet's video formats. Each available progressive MP4 is exposed as a file and sent to the existing aria2 download queue.
- Public posts with multiple videos are supported; the highest-quality progressive MP4 with audio is preferred.
- The current implementation does **not** download HLS-only streams, images, private/login-required posts, or DRM content. A video that cannot be resolved to a direct MP4 is rejected explicitly instead of sending an HLS playlist to aria2.
- Set up `yt-dlp` with `scripts/prepare-ytdlp.ps1` before building the Windows desktop package. Keep `yt-dlp` updated if X changes its extraction logic.
- This is a desktop/local backend feature: it does not add server-side media storage, browser-based MP4 proxying, or X account login.

## 影视源下载

打开桌面版顶部的「影视源下载」，粘贴影视仓 / TVBox 的配置网址或 JSON，点击「一键导入影视源」。支持 MacCMS JSON 站点（`type=1`），以及 Type3 JavaScript、标准 JVM JAR 和不依赖原生库的 DEX 转 JVM 调用。选择站点搜索影片、查看详情并点击剧集的「解析并下载」。MP4 使用 aria2，HLS 点播使用便携包内置的 FFmpeg 合并为 MP4。进度、失败原因和文件目录可在「下载管理」中查看。

导入只保存配置。每个 Type3 站点能否运行还取决于脚本接口、Android API 和依赖库，实际执行错误会显示在界面。包含 Android ARM 原生库的加固 Spider（如当前王二小 newwex）尚未兼容。能力边界及真实测试记录见 [Type3 兼容性报告](docs/TYPE3_COMPATIBILITY.md)。对包含 Android ARM `.so` 的 `csp_*` 站点，可选使用 [ADB 转发的 Android Spider Gateway](docs/TYPE3_ANDROID_GATEWAY.md)：Android 运行真正的 Spider，Windows 接收搜索/详情/线路 JSON；当前不支持 Android 本地媒体代理流的跨设备直接下载，仍需真机验收。已有最终 m3u8 地址时，可展开「直接下载 m3u8」。HLS 支持 MPEG-TS、fMP4 和标准 AES-128 点播，直播、DRM 和外置音轨暂不支持。暂停后的 HLS 任务从头下载。

构建 Type3 桌面运行时：从 TVBoxPC v1.8.1 发布页取得 `TVBoxPC_v1.8.1.zip`，执行 `npm run prepare:type3-java -- -ArchivePath <文件路径> -Force`。准备脚本复制 JRE、Android 桩、dex2jar 与库文件，编译本项目 Runner 并保留各依赖的许可声明。便携包包含该运行时，使用者不需要另外安装 Java。`npm run test:type3` 执行脚本、JVM、DEX 和 provider 集成回归；`node tests/e2e/type3LiveSmoke.mjs` 执行需联网的 NASA 自写验收源，并记录王二小实际执行结果。

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
- `npm run dist:win`: runs the release checks and creates the Windows x64 portable package

Before packaging on Windows, prepare the bundled executables with `scripts/prepare-aria2.ps1`, `scripts/prepare-ytdlp.ps1`, and `scripts/prepare-ffmpeg.ps1`.

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

- The desktop client can control local `aria2` through JSON-RPC for multithreaded downloads
- `aria2c.exe` must exist at `resources/aria2/win/aria2c.exe`
- The source repository does not commit `aria2c.exe`
- Developers can prepare it with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1
```

- Official portable release builds should run the prepare script before `npm run dist:win` so the packaged app includes `aria2c.exe`
- Default download directory: `Downloads/QuarkDownloads`
- Users can change the download directory from the desktop UI. Development mode stores this in `data/settings.json`; Electron desktop mode stores it under Electron `userData`.
- Removing a task supports two modes: remove only the aria2 task record, or remove the task record and its local file.
- Local file deletion is restricted to files that belong to the aria2 task and are inside the configured or default download directory.
- If `aria2c.exe` is missing:
  - Quark parsing still works
  - Browser download still works
  - Local proxy download still works
  - The built-in downloader is shown as unavailable
- Large files are better suited to the built-in downloader than normal browser download
- Downloader health is available at `GET /api/downloads/health`

## Bilibili Provider

- V0.8 uses `yt-dlp.exe` as a local sidecar for public Bilibili resource parsing.
- `yt-dlp.exe` must exist at `resources/yt-dlp/win/yt-dlp.exe` for real Bilibili parsing.
- The source repository does not commit `yt-dlp.exe`.
- Developers can prepare it with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-ytdlp.ps1
```

- If `yt-dlp.exe` is missing or parsing fails, the Provider falls back to stable mock data so registry and downloader handoff tests still work.
- DASH audio/video merge, member-only content, paid content, region-restricted content, DRM-protected content, and login-state handling are not supported in this version.

## Provider API

The current frontend resource flow uses the Provider API:

```http
POST /api/providers/resolve
POST /api/providers/list
POST /api/providers/download
```

Responses wrap the existing contracts:

- `resolve` returns `{ providerId, share }`
- `list` returns `{ providerId, list }`
- `download` returns `{ providerId, download }`

`/api/quark/*` remains available and compatible for existing callers.

## Current Boundaries

- This does **not** include ffmpeg merging
- This does **not** include a complex Provider UI selector; source detection is automatic from the resource link
- This does **not** include auto-update
- This does **not** include installer distribution
- This does **not** change existing `/api/quark/*` routes

## Project Docs

- [Roadmap](docs/ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Decisions](docs/DECISIONS.md)

## Compatibility Notes

- Existing Quark code remains in `server/services/quark/*` and `server/adapters/quarkApi.ts`; the V0.6 Quark Provider is a first-stage wrapper
- Bilibili Provider uses `yt-dlp` for real public-resource parsing when available and keeps mock fallback for validation
- Provider debug status is available at `GET /api/providers/debug`
- Provider main entry is available at `/api/providers/resolve`, `/api/providers/list`, and `/api/providers/download`
- Current download behavior supports both browser delivery and embedded aria2 delivery
- Electron manages the local desktop shell, backend lifecycle, and aria2 sidecar lifecycle
