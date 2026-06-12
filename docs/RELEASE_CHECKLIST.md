# V0.5.3 Release Checklist

This checklist records release readiness for the Electron + Local Express + aria2 portable desktop MVP.

## Scope Boundaries

- Do not change `/api/quark/*`.
- Do not add Bilibili support.
- Do not add Provider abstraction.
- Do not add ffmpeg.
- Do not add installer distribution or auto-update.
- Do not redesign the UI.

## Pre-Packaging Checks

- [ ] `git status --short --branch` is clean except intended release changes.
- [ ] Dependencies are installed.
- [ ] `.env` is local only and not committed.
- [ ] `resources/aria2/win/aria2c.exe` is ignored by Git.
- [ ] If the release should include the built-in downloader, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1
```

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

- [x] `/api/health` returns `ok=true`.
- [x] `/api/downloads/health` returns `enabled=false`.
- [x] `/api/downloads/active` returns `enabled=false`.
- [x] Quark share parsing works.

Result:

- Status: passed on 2026-06-12.
- Notes: Temporarily moved `resources/aria2/win/aria2c.exe` aside. App started, Quark stayed usable, and the download task panel showed the setup command.

## aria2 Available Scenario

Expected behavior:

- `aria2c.exe --version` succeeds.
- Electron starts aria2 as a local sidecar.
- `/api/downloads/health` returns `enabled=true`.
- Mock download links can be added to aria2.
- Pause / resume / remove should be tested on an active task. Very short tasks may finish too quickly to pause.

Validation:

- [x] `resources/aria2/win/aria2c.exe --version` succeeds.
- [x] `/api/downloads/health` returns `enabled=true`.
- [x] `/api/downloads/active` returns `enabled=true`.
- [x] `/api/downloads/add` creates a task.
- [x] `/api/downloads/status/:gid` returns task status.
- [x] `/api/downloads/pause/:gid` works on an active task.
- [x] `/api/downloads/resume/:gid` works on a paused task.
- [x] `/api/downloads/remove/:gid` removes or clears the task.

Result:

- Status: passed on 2026-06-12.
- Notes: `prepare-aria2.ps1` verified aria2 1.37.0. Mock download task created gid `9309cc1565c68287`; status, pause, resume, and remove all returned success.

## Quark Main Flow

Validation:

- [x] `/api/health`
- [x] `/api/quark/share`
- [x] `/api/quark/list`
- [x] `/api/quark/download`
- [ ] `/api/quark/download-proxy`
- [x] `QUARK_MOCK=true`

Result:

- Status: partially passed on 2026-06-12.
- Notes: Real share parsing and folder listing passed for `https://pan.quark.cn/s/01dc6a062f17#/list/share`. Both `.nsp` files in that share returned `download_restricted`, so no valid proxy token was available for a successful real proxy call in this run. Mock mode covered `/api/quark/download` success and downloader handoff.

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

- Status: blocked by Quark restriction on 2026-06-12.
- Notes: The 3.51 GB file `[本体v1.0.0][010015100B514000][16.0.3][中文].nsp` resolved in the file list, but `/api/quark/download` returned `download_restricted`: `该文件被夸克限制直链下载。普通小文件可正常解析；此类文件可能需要更高登录态、转存后下载，或被风控限制。` No proxy URL was issued, so aria2 could not be exercised against this real file in this run.

## Portable Package

Port handling:

- Development usually uses port `3000`.
- Portable mode may choose a free port from `3000-3010`.
- Use the actual Electron backend port or visible page status for validation.
- Do not treat `127.0.0.1:3000` as the only valid portable port.

Validation:

- [x] `npm run dist:win` succeeds.
- [x] A portable exe is generated under `release/`.
- [x] If `release/win-unpacked` exists, it contains the aria2 resource when `aria2c.exe` was prepared before packaging.
- [x] Launch the portable exe.
- [x] `/api/downloads/health` on the actual backend port returns `enabled=true` when packaged with aria2.

Result:

- Status: passed on 2026-06-12.
- Notes: `release/Quark Desktop MVP 0.1.0.exe` was generated. `release/win-unpacked/resources/aria2/win/aria2c.exe` exists. Launched portable exe and probed actual backend port `3000`; `/api/downloads/health` returned `enabled=true`.

## Process Cleanup

After closing the desktop client:

- [x] The Express backend started by the app exits.
- [x] The `aria2c.exe` process started by the app exits.
- [x] Task Manager does not show an aria2 process left by this app.

Result:

- Status: passed on 2026-06-12.
- Notes: Closed the portable app and verified no app-owned Quark, node, or aria2 processes remained.

## V0.5.3 Validation Record

- Commit: `v0.5.3 release checklist and downloader status cleanup`
- Tag: `v0.5.3`
- Build result: `npm run build` passed.
- Electron dev result: started in no-aria2, aria2-enabled, and mock modes; long-running command timed out as expected after startup, while API health checks passed.
- Portable result: `npm run dist:win` passed, portable exe launched, and download health returned `enabled=true`.
- Known limitations: Real 1GB+ Quark download was blocked by `download_restricted` for the available test share, so the real large-file aria2 transfer could not be observed for 1-3 minutes in this run.
