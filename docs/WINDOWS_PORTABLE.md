# Windows x64 portable EXE: fully bundled runtime

This is a **single-file portable EXE** created by GitHub Actions on Windows. No MSI installer or administrator rights are required. Electron embeds Node.js, and the build packages aria2, yt-dlp, gallery-dl, FFmpeg and FFprobe into the EXE. The user does not install Node.js, npm, Python or FFmpeg manually.

## Build steps

The workflow `.github/workflows/windows-portable.yml` downloads official, pinned archives in GitHub Actions, verifies exact SHA-256 digests, runs Windows tests, builds the client/server/Electron programs, and runs electron-builder in Windows x64 portable mode.

Pinned upstream binary inputs:

| Tool | Version | SHA-256 |
| --- | --- | --- |
| aria2 zip | 1.37.0 Windows 64-bit build1 | `67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288` |
| aria2c.exe | 1.37.0 | `be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2` |
| yt-dlp.exe | 2026.10.26 | `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d` |
| gallery-dl Windows EXE | 2026.11.05 (gdl-org/builds) | `dcfc5b0d5e6059b21a72765cfd77d0691754aa0294dee62813ae2e1ca553560d` |
| FFmpeg LGPL Win64 ZIP | BtbN autobuild-2026-11-05-12-48 | `0c813ecf72481a5ee39480423551e4bea230d8249b7d1d2130c7c8b2d61c4c44` |

FFmpeg's corresponding licenses are copied when available in the upstream archive, together with all DLLs co-located with the executable.

## Install-free usage

1. Visit the successful **Windows self-contained portable EXE** Actions run in GitHub.
2. Download the `NetPanDownload-Windows-x64-Portable-...` workflow artifact ZIP.
3. Unzip it, check the EXE SHA-256 against the workflow log, and double-click the portable EXE.
4. The app automatically checks bundled aria2, yt-dlp, gallery-dl, FFmpeg and FFprobe on start, sets the HLS runtime executable path, and opens the desktop UI.

The program does **not** install system packages, change global PATH, run elevation prompts, or fetch arbitrary tools on the target computer. If a component is corrupt or missing, it explains which feature is affected and asks the user to replace the EXE with a complete, verified build.

Windows 10/11 x64, sufficient disk space and network access for downloading video are still required. The EXE is **unsigned**, so Windows SmartScreen may warn about unknown publisher; do not claim code-signing or a security reputation. Verifying the SHA-256 hash is recommended.

## Scope

HLS v1 supports complete MPEG-TS VOD, ordinary AES-128 identity key decryption, and offline remux to MP4. It does not bypass DRM or support fMP4, LL-HLS, DASH, live streaming or Spider/JAR execution. The GitHub-generated test video checks the MP4 format and duration; it is not third-party content validation.

## Redistribution and licenses

Respect upstream licenses, attribution and corresponding source obligations before public release. Key upstreams:
- https://github.com/aria2/aria2 (GPL)
- https://github.com/yt-dlp/yt-dlp (Unlicense)
- https://github.com/gdl-org/builds (gallery-dl; GPL-2.0)
- https://github.com/BtbN/FFmpeg-Builds (FFmpeg LGPL build)
- https://ffmpeg.org/legal.html

