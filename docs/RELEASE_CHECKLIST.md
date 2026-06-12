# V0.8 Release Checklist

This checklist records release readiness for the Electron + Local Express + Quark + aria2 + Provider desktop MVP.

## Scope Boundaries

- Do not change `/api/quark/*`.
- Do not redesign the UI.
- Do not add ffmpeg merge.
- Do not handle paid, member-only, region-locked, or DRM-protected Bilibili content.
- Do not add installer distribution or auto-update.
- Do not expose Cookie, UA, Referer, aria2 RPC secret, or sidecar internals to the frontend.

## Pre-Packaging Checks

- [ ] `git status --short --branch` is clean except intended release changes.
- [ ] Dependencies are installed.
- [ ] `.env` is local only and not committed.
- [ ] `resources/aria2/win/aria2c.exe` is ignored by Git.
- [ ] `resources/yt-dlp/win/yt-dlp.exe` is ignored by Git.
- [ ] If the release should include the built-in downloader, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1
```

- [ ] If the release should include real Bilibili parsing, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-ytdlp.ps1
```

## Download Directory Settings

Expected behavior:

- First run uses `Downloads/QuarkDownloads`.
- Desktop users can choose a download directory from the task panel.
- Development / plain Express mode stores settings in `data/settings.json`.
- Electron desktop mode stores settings under Electron `userData`.
- New aria2 tasks use the configured directory unless a one-off `dir` is passed to `/api/downloads/add`.

Validation:

- [ ] `GET /api/downloads/settings` returns the effective directory and default directory.
- [ ] `POST /api/downloads/settings` creates and saves a valid directory.
- [ ] `/api/downloads/health` reports the configured directory in `defaultDir`.
- [ ] `/api/downloads/active` reports the configured directory in `defaultDir`.
- [ ] A newly added aria2 task uses the configured directory.
- [ ] "Open download directory" opens the configured directory.

Result:

- Status: not rerun in V0.8.
- Notes: V0.8 does not change download directory logic. Keep V0.5.4 validation as the baseline unless this module changes.

## Task Removal Behavior

Expected behavior:

- Removing a task without `deleteFile` keeps the local file.
- Removing a task with `deleteFile=true` deletes only the aria2 task file.
- The backend never accepts an arbitrary frontend file path.
- File deletion is limited to the configured or default download directory.

Validation:

- [ ] `POST /api/downloads/remove/:gid` with `{ "deleteFile": false }` removes only the record.
- [ ] `POST /api/downloads/remove/:gid` with `{ "deleteFile": true }` removes the record and local file.
- [ ] Directory deletion is rejected.
- [ ] Files outside allowed download directories are rejected.
- [ ] Completed, paused, and error tasks return either success or a readable error.

Result:

- Status: not rerun in V0.8.
- Notes: V0.8 does not change task removal logic. Keep V0.5.4 validation as the baseline unless this module changes.

## No aria2 Scenario

Expected behavior:

- The app starts.
- Quark parsing still works.
- Browser download and local proxy download still work.
- Built-in downloader shows unavailable.
- Download task panel shows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1
```

Validation:

- [ ] `/api/health` returns `ok=true`.
- [ ] `/api/downloads/health` returns `enabled=false`.
- [ ] `/api/downloads/active` returns `enabled=false`.
- [ ] Quark share parsing works.

Result:

- Status: not rerun in V0.8.
- Notes: V0.8 test environment already had `aria2c.exe` prepared before desktop validation.

## aria2 Available Scenario

Expected behavior:

- `aria2c.exe --version` succeeds.
- Electron starts aria2 as a local sidecar.
- `/api/downloads/health` returns `enabled=true`.
- Download links authorized by the app can be added to aria2.
- Pause / resume / remove should be tested on an active task. Very short tasks may finish too quickly to pause.

Validation:

- [ ] `resources/aria2/win/aria2c.exe --version` succeeds.
- [ ] `/api/downloads/health` returns `enabled=true`.
- [ ] `/api/downloads/active` returns `enabled=true`.
- [ ] `/api/downloads/add` creates a task.
- [ ] `/api/downloads/status/:gid` returns task status.
- [ ] `/api/downloads/pause/:gid` works on an active task.
- [ ] `/api/downloads/resume/:gid` works on a paused task.
- [ ] `/api/downloads/remove/:gid` removes or clears the task.

Result:

- Status: passed on 2026-06-12.
- Notes: `prepare-aria2.ps1` verified aria2 1.37.0. Electron dev and portable both reported `/api/downloads/health` with `enabled=true`. A Bilibili Provider mock fallback URL was accepted by `/api/downloads/add` and the created task was removed successfully.

## yt-dlp Sidecar

Expected behavior:

- Git source does not include `yt-dlp.exe`.
- Developers prepare it with `scripts/prepare-ytdlp.ps1`.
- Portable releases may include it when the prepare script is run before packaging.
- If it is missing, Bilibili Provider falls back to mock data and Quark stays usable.

Validation:

- [ ] `resources/yt-dlp/win/yt-dlp.exe` is ignored by Git.
- [ ] `powershell -ExecutionPolicy Bypass -File scripts/prepare-ytdlp.ps1` succeeds.
- [ ] `resources/yt-dlp/win/yt-dlp.exe --version` succeeds.
- [ ] Missing `yt-dlp.exe` does not prevent Electron startup.
- [ ] Missing `yt-dlp.exe` does not affect `/api/quark/*` or `/api/downloads/*`.

Result:

- Status: partially passed on 2026-06-12.
- Notes: `prepare-ytdlp.ps1` downloaded `yt-dlp.exe` and verified version `2026.06.09`. Packaged `release/win-unpacked/resources/yt-dlp/win/yt-dlp.exe` exists. A direct yt-dlp test against `https://www.bilibili.com/video/BV1GJ411x7h7` returned Bilibili HTTP 412 in this network, so Provider fallback behavior was exercised instead of a successful real parse.

## Provider Registry

Validation:

- [ ] `GET /api/providers/debug` returns `registered: ["quark", "bilibili"]`.
- [ ] `GET /api/providers/debug?input=<quark-share-url>` reports Quark as matched.
- [ ] `GET /api/providers/debug?input=<bilibili-url>` reports Bilibili as matched.
- [ ] Unsupported input returns `unsupported_provider` from resolve debug.
- [ ] Provider Registry does not alter `/api/quark/*` response contracts.

Result:

- Status: passed on 2026-06-12.
- Notes: `GET /api/providers/debug` returned `["quark", "bilibili"]`. Quark input matched `quark`; Bilibili input matched `bilibili`; unsupported input returned `unsupported_provider` with a readable Chinese message. Existing `/api/quark/share` returned the expected mock response under `QUARK_MOCK=true`.

## Bilibili Provider

Supported in V0.8:

- Public Bilibili videos or bangumi URLs that `yt-dlp` can resolve without login or merge.
- Stable mock fallback when the sidecar is unavailable or parsing fails.
- Download handoff to aria2 through existing `/api/downloads/add` authorization.

Not supported in V0.8:

- Paid content.
- Member-only content.
- Region-locked content.
- DRM-protected content.
- DASH video/audio merge requiring ffmpeg.
- Bilibili login state.

Validation:

- [ ] `/api/providers/debug/resolve` returns a standard `ShareResult` for a Bilibili URL or stable mock fallback.
- [ ] `/api/providers/debug/list` returns a standard `ListResult`.
- [ ] `/api/providers/debug/download` returns a standard `DownloadResult` for supported single-file streams.
- [ ] `bilibili_dash_unsupported` is returned for resources that require ffmpeg merge.
- [ ] Bilibili `downloadUrl` can be submitted to `/api/downloads/add`.

Result:

- Status: partially passed on 2026-06-12.
- Notes: `/api/providers/debug/resolve`, `/debug/list`, and `/debug/download` returned standard `ShareResult`, `ListResult`, and `DownloadResult` using mock fallback. Real yt-dlp resolution was blocked by Bilibili HTTP 412 for the sampled public URL in this environment. The fallback `downloadUrl` was registered and accepted by `/api/downloads/add` while aria2 was enabled.

## Quark Main Flow

Validation:

- [ ] `/api/health`
- [ ] `/api/quark/share`
- [ ] `/api/quark/list`
- [ ] `/api/quark/download`
- [ ] `/api/quark/download-proxy`
- [ ] `QUARK_MOCK=true`

Result:

- Status: partially passed on 2026-06-12.
- Notes: `/api/health` and `/api/quark/share` passed under `QUARK_MOCK=true`. V0.8 does not change `/api/quark/*`; deeper real Quark download/proxy regression was not rerun in this pass.

## Real Large File Regression

Use a 1GB+ Quark file when available.

Steps:

- [ ] Resolve the share.
- [ ] Get a real download result or `proxyUrl`.
- [ ] Click or call "use built-in downloader".
- [ ] Confirm an aria2 task is created.
- [ ] Observe progress and speed for 1-3 minutes.
- [ ] Test pause and resume while the task is active.
- [ ] Remove the task after validation.

If Quark risk control, login state, token expiry, or CDN callback auth blocks the test, record the exact error and behavior.

Result:

- Status: not rerun in V0.8.
- Notes: V0.8 does not change Quark proxy download behavior. Large-file regression remains dependent on Quark login state, risk control, and CDN callback authorization.

## Portable Package

Port handling:

- Development usually uses port `3000`.
- Portable mode may choose a free port from `3000-3010`.
- Use the actual Electron backend port or visible page status for validation.
- Do not treat `127.0.0.1:3000` as the only valid portable port.

Validation:

- [ ] `npm run dist:win` succeeds.
- [ ] A portable exe is generated under `release/`.
- [ ] If `release/win-unpacked` exists, it contains aria2 resource when `aria2c.exe` was prepared before packaging.
- [ ] If `release/win-unpacked` exists, it contains yt-dlp resource when `yt-dlp.exe` was prepared before packaging.
- [ ] Launch the portable exe.
- [ ] `/api/downloads/health` on the actual backend port returns `enabled=true` when packaged with aria2.
- [ ] Provider debug on the actual backend port returns both providers.

Result:

- Status: passed on 2026-06-12.
- Notes: `npm run dist:win` succeeded. `release/Quark Desktop MVP 0.1.0.exe` was generated. `release/win-unpacked/resources/aria2/win/aria2c.exe` and `release/win-unpacked/resources/yt-dlp/win/yt-dlp.exe` exist. Portable started on actual backend port `3000`; `/api/downloads/health` returned `enabled=true`; Provider debug returned both providers.

## Process Cleanup

After closing the desktop client:

- [ ] The Express backend started by the app exits.
- [ ] The `aria2c.exe` process started by the app exits.
- [ ] No app-owned `yt-dlp.exe` process remains.
- [ ] Task Manager does not show sidecar processes left by this app.

Result:

- Status: passed on 2026-06-12.
- Notes: After closing the portable app, no app-owned `node.exe`, `electron.exe`, `aria2c.exe`, or `yt-dlp.exe` processes remained.

## V0.8 Validation Record

- Commit:
- Tag:
- Build result: `npm run build`, `npm run build:electron`, and `npm run dist:win` passed.
- Electron dev result: `npm run electron:dev` stayed running through the startup window; `/api/health`, `/api/downloads/health`, and `/api/providers/debug` passed on the actual development backend.
- Portable result: Portable exe launched, download health returned `enabled=true`, and Provider debug returned both providers.
- Provider result: Bilibili match and mock fallback passed; real yt-dlp parse was blocked by Bilibili HTTP 412 for the sampled URL.
- Known limitations: No ffmpeg/DASH merge, no Bilibili login state, no paid/member/region/DRM handling, and real Bilibili parsing may fallback when Bilibili rejects anonymous yt-dlp requests.
