# NetPanDownload Android (standalone preview)

This is a **real, locally running Android app**, not a WebView connected to a VPS.
The existing Windows Electron / Express implementation is unchanged.

## Features

- Public Instagram Reel and post-video links (`instagram.com/reel/...`, `instagram.com/p/...`, `instagram.com/tv/...`), including share-to-app and tracking-query cleanup. The app matches embedded public page data to the requested post and downloads its MP4 renditions directly. Mixed carousels save their videos in post order. The extraction approach is based on [InstaDownload v3.1.0](https://github.com/Orang-Studio/InstaDownload/releases/tag/v3.1.0).
- X/Twitter public tweet links (including share-to-app); Bilibili and YouTube links supported by the bundled yt-dlp extractor
- Other public media sites supported by yt-dlp may work; not guaranteed
- On-device yt-dlp + FFmpeg, download progress, cancellation, import into the **Downloads/NetPanDownload** public folder via MediaStore
- No remote service, cloud parser, account or API token
- Downloads currently execute while the activity is alive; closing the app ends the download
- Instagram webpage extraction targets publicly available Reels and post videos. Stories, profiles and image downloads are outside this feature.
- If the public webpage or direct MP4 download fails, the app retries through the on-device yt-dlp extractor. The in-app "更新 yt-dlp 解析器（官方稳定版）" button updates this fallback over GitHub.
- Both **解析信息** and **下载视频到手机** can be cancelled. The public page request has a 20-second timeout and the MP4 connection has a 15-second read timeout. The yt-dlp watchdog stops the process after 120 seconds before download start or 90 seconds of download inactivity.
- Errors show a selectable last-log summary and distinguish authentication, 429, 403, extractor issues and timeouts. A "No csrf token" warning alone is not treated as the primary error.
- Optional: import your own Netscape `cookies.txt` using Android's document picker for Instagram login-required posts. The file stays in app-private storage and is used only by the Instagram yt-dlp fallback. Use "清除已导入的 Instagram Cookies" when finished.
- No guarantee every Reel is accessible: Instagram changes its restrictions and some public content still cannot be extracted on Android.
- **Quark**: QR login, token retrieval, directory listing and transfer/download are not ported. Links are explicitly rejected, not silently routed to a server
- A **Open Download Folder** button lists `Download/NetPanDownload`, including files from older installations. Android's MediaStore can only access app-owned downloads directly; therefore, the first time you open this screen, choose **Download/NetPanDownload** (NOT the Download root) in the Android Storage Access Framework picker, granting persisted folder access. After authorization the button immediately opens the full folder contents. A manual re-authorize button is provided. The app requests no broad storage permission.
- File names are sanitized and saved with Android MediaStore; no broad storage permissions required
- APK is a debug build, for personal installation and validation only

## Instagram validation

- The GitHub workflow executes `testDebugUnitTest` and `assembleDebug`. Tests cover URL handling, exact post matching, video renditions, mixed carousels and failure diagnostics.
- On an Android device, paste the [reported Reel](https://www.instagram.com/reel/DfY_JAozJVV/) and tap **解析信息**. Check that **解析方式** shows **Instagram 网页**. Tap **下载视频到手机** and verify that the saved MP4 plays from **打开下载文件夹**.

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
- Add device instrumentation tests including real X/Bilibili/Instagram URLs
