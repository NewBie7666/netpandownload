# NetPanDownload Android (standalone preview)

This is a **real, locally running Android app**, not a WebView connected to a VPS.
The existing Windows Electron / Express implementation is unchanged.

## Features

- Public Instagram Reel and post-video links (`instagram.com/reel/...`, `instagram.com/p/...`, `instagram.com/tv/...`), including share-to-app and tracking-query cleanup; extracts with on-device yt-dlp and prefers muxed MP4. A video carousel may produce multiple files.
- X/Twitter public tweet links (including share-to-app); Bilibili and YouTube links supported by the bundled yt-dlp extractor
- Other public media sites supported by yt-dlp may work; not guaranteed
- On-device yt-dlp + FFmpeg, download progress, cancellation, import into the **Downloads/NetPanDownload** public folder via MediaStore
- No remote service, cloud parser, account or API token
- Downloads currently execute while the activity is alive; closing the app ends the download
- Instagram support is limited to **public videos that do not require login**; private posts, Stories, account login, image-only posts and image downloads are not supported. Instagram may block even public videos. No credentials or cookies are collected.
- Private/login-protected media may fail; yt-dlp can be updated in a future version
- **Quark**: QR login, token retrieval, directory listing and transfer/download are not ported. Links are explicitly rejected, not silently routed to a server
- A **Open Download Folder** button lists `Download/NetPanDownload`, including files from older installations. Android's MediaStore can only access app-owned downloads directly; therefore, the first time you open this screen, choose **Download/NetPanDownload** (NOT the Download root) in the Android Storage Access Framework picker, granting persisted folder access. After authorization the button immediately opens the full folder contents. A manual re-authorize button is provided. The app requests no broad storage permission.
- File names are sanitized and saved with Android MediaStore; no broad storage permissions required
- APK is a debug build, for personal installation and validation only

## Instagram validation

- Android/JUnit: validate public `/reel/`, `/p/`, `/tv/` URLs, schemeless and shared text, stripped tracking params, suspicious domains, and existing video-provider behavior.
- The GitHub workflow executes `testDebugUnitTest` and `assembleDebug`. A successful build does **not** prove Instagram's live extraction works: that requires a public real Reel on an Android phone and a network allowed by Instagram.
- In the app paste/share a public Reel, tap **解析信息**, then **下载视频到手机**, and verify the output with **打开下载文件夹**.

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
