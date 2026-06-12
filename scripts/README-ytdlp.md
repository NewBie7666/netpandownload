# yt-dlp sidecar

V0.8 uses `yt-dlp.exe` as the Bilibili Provider sidecar.

## Source repository policy

- Git does not commit `yt-dlp.exe`.
- Developers can prepare it locally with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-ytdlp.ps1
```

- The script downloads `yt-dlp.exe` from the official `yt-dlp/yt-dlp` GitHub releases and verifies:

```powershell
resources/yt-dlp/win/yt-dlp.exe --version
```

## Release policy

Run the prepare script before `npm run dist:win` if the portable release should include real Bilibili parsing.

If `yt-dlp.exe` is missing:

- Quark still works.
- The downloader still works.
- Bilibili Provider falls back to stable mock data.
- Real Bilibili parsing is unavailable.

V0.8 does not support paid, member-only, region-locked, DRM-protected, or DASH merge workflows.
