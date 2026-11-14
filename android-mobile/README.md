# NetPanDownload Android (standalone preview)

This is a **real, locally running Android app**, not a WebView connected to a VPS.
The existing Windows Electron / Express implementation is unchanged.

## Features

- X/Twitter public tweet links (including share-to-app); Bilibili and YouTube links supported by the bundled yt-dlp extractor
- Other public media sites supported by yt-dlp may work; not guaranteed
- On-device yt-dlp + FFmpeg, download progress, cancellation, import into the **Downloads/NetPanDownload** public folder via MediaStore
- No remote service, cloud parser, account or API token
- Downloads currently execute while the activity is alive; closing the app ends the download
- Private/login-protected media may fail; yt-dlp can be updated in a future version
- **Quark**: QR login, token retrieval, directory listing and transfer/download are not ported. Links are explicitly rejected, not silently routed to a server
- File names are sanitized and saved with Android MediaStore; no broad storage permissions required
- APK is a debug build, for personal installation and validation only

## Build with GitHub Actions

Go to Actions > `Android standalone APK` > Run workflow (or open a PR).
Wait for `android-debug-apk` to succeed; download the artifact `NetPanDownload-Android-arm64-debug`.
Unzip the artifact and install `app-debug.apk` on an ARM64 Android 10+ phone.
No computer or VPS connection is needed while using it; the phone still needs internet access to fetch videos.

## Local build

Install Android SDK 35, JDK 17 and Gradle 8.11.1:

```sh
gradle -p android-mobile :app:testDebugUnitTest :app:assembleDebug
```

The Android library is `io.github.junkfood02.youtubedl-android` 0.18.1.
Its Python/yt-dlp runtime and FFmpeg are bundled in the APK. The build can be large.

## Follow-ups

- Move long running downloads to a foreground Service so they continue with app in background
- Add persistent task queue, pause/resume and richer format selection
- Port Quark auth/session/network calls independently of Node
- Add device instrumentation tests including real X/Bilibili URLs
