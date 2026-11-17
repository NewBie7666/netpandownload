package com.newbie7666.netpandownload.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.content.Context;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import kotlin.Unit;

/**
 * Standalone downloader. No Express, Electron, LAN service or cloud parser.
 * yt-dlp/FFmpeg run locally and completed files are published through MediaStore.
 */
public final class MainActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private final InstagramProvider instagram = new InstagramProvider(cancelled::get);
    private final AtomicBoolean timedOut = new AtomicBoolean(false);
    private final ScheduledExecutorService timeoutWorker = Executors.newSingleThreadScheduledExecutor();
    private final StringBuilder lastLog = new StringBuilder();
    private static final int COOKIE_PICKER_REQUEST = 1931;
    private static final long EXTRACT_TIMEOUT_MS = 120_000L;
    private static final long STALL_TIMEOUT_MS = 90_000L;
    private volatile long commandStartMs;
    private volatile long lastActivityMs;
    private volatile boolean downloadStarted;

    private EditText linkField;
    private TextView statusText;
    private TextView detailsText;
    private ProgressBar progressBar;
    private Button inspectButton;
    private Button downloadButton;
    private Button cancelButton;
    private Button updateExtractorButton;
    private Button importCookieButton;
    private Button clearCookieButton;
    private TextView extractorVersionText;
    private volatile boolean busy;
    private boolean mediaTaskActive;
    private volatile boolean ready;
    private volatile String activeProcessId = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        renderScreen();
        receiveSharedText(getIntent());
        worker.execute(() -> {
            try {
                YoutubeDL.getInstance().init(getApplicationContext());
                FFmpeg.getInstance().init(getApplicationContext());
                ready = true;
                String version = extractorVersion();
                updateStatus("解析器就绪。公开 Instagram 视频优先使用网页解析。");
                runOnUiThread(() -> {
                    extractorVersionText.setText("yt-dlp 版本：" + version);
                    setButtons(false);
                });
            } catch (Exception error) {
                updateStatus("初始化失败：" + friendlyError(error));
                runOnUiThread(() -> setButtons(false));
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receiveSharedText(intent);
    }

    private int dp(float n) {
        return Math.round(n * getResources().getDisplayMetrics().density);
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private void renderScreen() {
        ScrollView scrolling = new ScrollView(this);
        scrolling.setFillViewport(true);
        scrolling.setBackgroundColor(Color.rgb(247, 249, 252));
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(28), dp(20), dp(20));
        scrolling.addView(content);

        TextView title = text("NetPanDownload", 28, Color.rgb(20, 31, 50));
        title.setTypeface(null, 1);
        content.addView(title);

        TextView subtitle = text("Android 独立下载器 · 无需电脑或 VPS", 14, Color.rgb(84, 98, 118));
        LinearLayout.LayoutParams subtitleParams = new LinearLayout.LayoutParams(-1, -2);
        subtitleParams.topMargin = dp(8);
        subtitleParams.bottomMargin = dp(26);
        content.addView(subtitle, subtitleParams);

        extractorVersionText = text("yt-dlp 版本：检测中…", 14, Color.rgb(84, 98, 118));
        content.addView(extractorVersionText);
        updateExtractorButton = new Button(this);
        updateExtractorButton.setText("更新 yt-dlp 解析器（官方稳定版）");
        updateExtractorButton.setEnabled(false);
        updateExtractorButton.setOnClickListener(v -> updateExtractor());
        content.addView(updateExtractorButton);

        TextView urlLabel = text("视频链接", 16, Color.rgb(30, 40, 55));
        content.addView(urlLabel);

        linkField = new EditText(this);
        linkField.setTextSize(15);
        linkField.setMinLines(2);
        linkField.setMaxLines(4);
        linkField.setGravity(Gravity.TOP);
        linkField.setHint("粘贴 Instagram Reels/帖子、X、B站、YouTube 视频地址");
        linkField.setSingleLine(false);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(-1, -2);
        inputParams.topMargin = dp(8);
        inputParams.bottomMargin = dp(12);
        content.addView(linkField, inputParams);

        LinearLayout firstRow = new LinearLayout(this);
        firstRow.setOrientation(LinearLayout.HORIZONTAL);

        Button pasteButton = new Button(this);
        pasteButton.setText("粘贴链接");
        pasteButton.setOnClickListener(v -> pasteFromClipboard());
        firstRow.addView(pasteButton, new LinearLayout.LayoutParams(0, -2, 1));

        inspectButton = new Button(this);
        inspectButton.setText("解析信息");
        inspectButton.setEnabled(false);
        inspectButton.setOnClickListener(v -> inspectLink());
        LinearLayout.LayoutParams inspectParams = new LinearLayout.LayoutParams(0, -2, 1);
        inspectParams.leftMargin = dp(8);
        firstRow.addView(inspectButton, inspectParams);
        content.addView(firstRow);

        downloadButton = new Button(this);
        downloadButton.setText("下载视频到手机");
        downloadButton.setEnabled(false);
        downloadButton.setTextColor(Color.WHITE);
        downloadButton.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(45, 94, 215)));
        downloadButton.setOnClickListener(v -> startDownload());
        LinearLayout.LayoutParams downloadParams = new LinearLayout.LayoutParams(-1, dp(54));
        downloadParams.topMargin = dp(10);
        content.addView(downloadButton, downloadParams);

        cancelButton = new Button(this);
        cancelButton.setText("取消当前任务");
        cancelButton.setEnabled(false);
        cancelButton.setOnClickListener(v -> cancelDownload());
        LinearLayout.LayoutParams cancelParams = new LinearLayout.LayoutParams(-1, -2);
        cancelParams.topMargin = dp(4);
        content.addView(cancelButton, cancelParams);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(-1, dp(9));
        progressParams.topMargin = dp(24);
        content.addView(progressBar, progressParams);

        statusText = text("初始化本地解析器中……", 15, Color.rgb(33, 48, 71));
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-1, -2);
        statusParams.topMargin = dp(12);
        content.addView(statusText, statusParams);

        detailsText = text("支持公开 Instagram Reels/帖子视频、X 帖子、B站及 YouTube。\n\n文件保存到 下载/NetPanDownload。\nInstagram 私密内容、Stories、纯图片帖子及需要登录的媒体暂不支持。\n当前任务需保持应用运行。", 14, Color.rgb(96, 109, 128));
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2);
        detailParams.topMargin = dp(16);
        content.addView(detailsText, detailParams);
        detailsText.setTextIsSelectable(true);

        importCookieButton = new Button(this);
        importCookieButton.setText("导入 Instagram cookies.txt（可选）");
        importCookieButton.setOnClickListener(v -> chooseCookieFile());
        content.addView(importCookieButton);

        clearCookieButton = new Button(this);
        clearCookieButton.setText("清除已导入的 Instagram Cookies");
        clearCookieButton.setOnClickListener(v -> clearCookieFile());
        content.addView(clearCookieButton);

        Button openDownloads = new Button(this);
        openDownloads.setText("打开下载文件夹");
        openDownloads.setOnClickListener(v ->
                startActivity(new Intent(this, DownloadFolderActivity.class)));
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(-1, -2);
        openParams.topMargin = dp(18);
        content.addView(openDownloads, openParams);

        setContentView(scrolling);
    }

    private void receiveSharedText(Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (shared != null) linkField.setText(shared);
        }
    }

    private void pasteFromClipboard() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null || !clipboard.hasPrimaryClip()) return;
        ClipData clip = clipboard.getPrimaryClip();
        if (clip != null && clip.getItemCount() > 0) {
            CharSequence value = clip.getItemAt(0).coerceToText(this);
            linkField.setText(value);
        }
    }

    private String checkedUrl() {
        String url = UrlTools.normalize(linkField.getText().toString());
        if (url.isEmpty()) {
            linkField.setError("请输入有效的 HTTP(S) 视频链接");
            return null;
        }
        if (!UrlTools.supportsDownload(url)) {
            updateStatus("暂不支持：" + UrlTools.category(url));
            return null;
        }
        return url;
    }

    private void setButtons(boolean isBusy) {
        inspectButton.setEnabled(ready && !isBusy);
        downloadButton.setEnabled(ready && !isBusy);
        updateExtractorButton.setEnabled(ready && !isBusy);
        importCookieButton.setEnabled(!isBusy);
        clearCookieButton.setEnabled(!isBusy);
        cancelButton.setEnabled(isBusy && mediaTaskActive);
    }

    private void setBusy(boolean value) {
        busy = value;
        runOnUiThread(() -> {
            if (!value) mediaTaskActive = false;
            setButtons(value);
        });
    }

    private void beginMediaTask() {
        cancelled.set(false);
        timedOut.set(false);
        resetLog();
        mediaTaskActive = true;
        setBusy(true);
    }

    private void updateStatus(String value) {
        runOnUiThread(() -> statusText.setText(value));
    }

    private void updateDetails(String value) {
        runOnUiThread(() -> detailsText.setText(value));
    }

    private void inspectLink() {
        if (busy || !ready) return;
        String url = checkedUrl();
        if (url == null) return;
        beginMediaTask();
        updateStatus("正在检查视频信息…");
        worker.execute(() -> {
            String taskId = "netpan-info-" + UUID.randomUUID();
            try {
                if (UrlTools.isInstagramVideoUrl(url)) {
                    try {
                        updateStatus("正在解析 Instagram 公开网页…");
                        InstagramPage.Post post = instagram.inspect(url);
                        checkMediaCancelled();
                        showVideoInfo(url, "Instagram 网页", post.title(), post.videos().size());
                        return;
                    } catch (IOException error) {
                        fallBackFromInstagram(error);
                    }
                }
                YoutubeDLRequest request = new YoutubeDLRequest(url);
                configureExtractorRequest(request, url);
                request.addOption("--skip-download");
                request.addOption("--dump-single-json");
                String json = runYtDlp(request, taskId, true);
                JSONObject info = new JSONObject(json.trim());
                String title = info.optString("title", "(无标题)");
                JSONArray entries = info.optJSONArray("entries");
                showVideoInfo(url, "yt-dlp", title, entries == null ? 0 : entries.length());
            } catch (Exception error) {
                if (cancelled.get()) updateStatus("解析已取消。");
                else {
                    updateStatus("解析失败：" + friendlyMediaError(url, error));
                    showFailureLog(error);
                }
            } finally {
                setBusy(false);
            }
        });
    }

    private void showVideoInfo(String url, String extractor, String title, int count) {
        String entryCount = count == 0 ? "" : "\n资源数量：" + count;
        updateDetails("来源：" + UrlTools.category(url) + "\n解析方式：" + extractor + "\n标题：" + title +
                entryCount + "\n\n可以点击「下载视频到手机」。");
        updateStatus("解析完成。");
    }

    private void fallBackFromInstagram(IOException error) throws InterruptedIOException {
        checkMediaCancelled();
        appendLog("Instagram 网页解析或下载：" + friendlyError(error));
        updateStatus("Instagram 网页处理未完成，正在尝试 yt-dlp…");
    }

    private void checkMediaCancelled() throws InterruptedIOException {
        if (cancelled.get()) throw new InterruptedIOException("用户取消任务");
    }

    private void startDownload() {
        if (busy || !ready) return;
        String url = checkedUrl();
        if (url == null) return;
        closeKeyboard();
        beginMediaTask();
        runOnUiThread(() -> progressBar.setProgress(0));
        updateStatus("准备下载：" + UrlTools.category(url));
        worker.execute(() -> performDownload(url));
    }

    private void closeKeyboard() {
        InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (manager != null && linkField.getWindowToken() != null) {
            manager.hideSoftInputFromWindow(linkField.getWindowToken(), 0);
        }
    }

    private void performDownload(String url) {
        File stage = null;
        String taskId = "netpan-" + UUID.randomUUID();
        try {
            File root = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (root == null) throw new IOException("手机存储不可用");
            stage = new File(root, "temp-" + taskId);
            if (!stage.mkdirs()) throw new IOException("无法创建临时文件夹");

            boolean isInstagram = UrlTools.isInstagramVideoUrl(url);
            List<File> nativeOutputs = isInstagram ? downloadInstagram(url, stage) : null;
            File[] outputs;
            if (nativeOutputs != null) {
                outputs = nativeOutputs.toArray(new File[0]);
            } else {
                YoutubeDLRequest request = new YoutubeDLRequest(url);
                configureExtractorRequest(request, url);
                request.addOption("--no-mtime");
                request.addOption("--yes-playlist");
                request.addOption("--merge-output-format", "mp4");
                request.addOption("--no-overwrites");
                request.addOption("-f", UrlTools.preferredFormat(url));
                request.addOption("-o", new File(stage, "%(extractor_key)s-%(id)s-%(autonumber)03d.%(ext)s").getAbsolutePath());
                runYtDlp(request, taskId, false);
                outputs = stage.listFiles();
            }

            checkMediaCancelled();
            int saved = 0;
            if (outputs != null) {
                for (File item : outputs) {
                    checkMediaCancelled();
                    if (item.isFile() && item.length() > 0 &&
                            !item.getName().endsWith(".part") &&
                            !item.getName().endsWith(".ytdl") &&
                            (!isInstagram || UrlTools.isVideoFilename(item.getName()))) {
                        publishDownload(item);
                        saved++;
                    }
                }
            }
            if (saved == 0) throw new IOException(isInstagram
                    ? "没有提取到视频文件：可能是纯图片帖子、需要登录或内容不可访问"
                    : "解析成功，但没有找到完整视频文件");
            final int total = saved;
            runOnUiThread(() -> progressBar.setProgress(100));
            updateStatus("下载完成，已保存 " + total + " 个文件到 Download/NetPanDownload");
            updateDetails("下载成功。点击「打开下载文件夹」即可查看并打开保存的视频。");
        } catch (Exception error) {
            if (cancelled.get()) updateStatus("下载已取消。");
            else {
                updateStatus("下载失败：" + friendlyMediaError(url, error));
                showFailureLog(error);
            }
        } finally {
            if (stage != null) deleteTree(stage);
            setBusy(false);
        }
    }

    private List<File> downloadInstagram(String url, File stage) throws IOException {
        File nativeStage = new File(stage, "instagram");
        if (!nativeStage.mkdir()) throw new IOException("无法创建 Instagram 临时文件夹");
        try {
            updateStatus("正在解析 Instagram 公开网页…");
            InstagramPage.Post post = instagram.inspect(url);
            updateStatus("Instagram MP4 下载中…");
            return instagram.download(post, nativeStage, percent -> runOnUiThread(() -> {
                if (cancelled.get()) return;
                progressBar.setProgress(Math.min(99, percent));
                statusText.setText("Instagram MP4 下载中：" + percent + "%");
            }));
        } catch (IOException error) {
            deleteTree(nativeStage);
            fallBackFromInstagram(error);
            return null;
        }
    }

    private void cancelDownload() {
        if (!busy) return;
        cancelled.set(true);
        updateStatus("正在取消任务……");
        instagram.cancel();
        String task = activeProcessId;
        if (!task.isEmpty()) {
            new Thread(() -> {
                try {
                    YoutubeDL.getInstance().destroyProcessById(task);
                } catch (Exception ignored) {
                    // The worker might have already completed.
                }
            }).start();
        }
    }

    private String extractorVersion() {
        try {
            return YoutubeDL.getInstance().versionName(getApplicationContext());
        } catch (Exception ignored) {
            return "未知";
        }
    }

    private void updateExtractor() {
        if (!ready || busy) return;
        setBusy(true);
        updateStatus("正在从官方渠道更新 yt-dlp；请保持应用运行及网络连接…");
        worker.execute(() -> {
            String before = extractorVersion();
            try {
                String result = YoutubeDL.getInstance()
                        .updateYoutubeDL(getApplicationContext(), YoutubeDL.UpdateChannel._STABLE)
                        .toString();
                String after = extractorVersion();
                updateStatus("yt-dlp 更新结果：" + result + "，版本 " + before + " → " + after);
                runOnUiThread(() -> extractorVersionText.setText("yt-dlp 版本：" + after));
            } catch (Exception error) {
                updateStatus("yt-dlp 更新失败（原解析器仍可用）："
                        + friendlyError(error) + "。请检查是否能访问 GitHub。");
            } finally {
                setBusy(false);
            }
        });
    }

    private File cookieFile() {
        return new File(getFilesDir(), "instagram-cookies.txt");
    }

    private void chooseCookieFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("text/plain");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(intent, COOKIE_PICKER_REQUEST);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != COOKIE_PICKER_REQUEST || resultCode != RESULT_OK ||
                data == null || data.getData() == null) return;
        Uri selected = data.getData();
        worker.execute(() -> {
            File temporary = new File(getFilesDir(), "instagram-cookies.tmp");
            try (InputStream input = getContentResolver().openInputStream(selected);
                 OutputStream output = new java.io.FileOutputStream(temporary)) {
                if (input == null) throw new IOException("无法读取文件");
                byte[] buffer = new byte[8192];
                long total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > 1024 * 1024) throw new IOException("Cookie 文件不能超过 1 MB");
                    output.write(buffer, 0, count);
                }
                output.flush();
            } catch (Exception error) {
                temporary.delete();
                updateStatus("Cookies 导入失败：" + friendlyError(error));
                return;
            }
            try {
                byte[] bytes = java.nio.file.Files.readAllBytes(temporary.toPath());
                String first = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
                if (!first.startsWith("# Netscape HTTP Cookie File") &&
                        !first.startsWith("# HTTP Cookie File") &&
                        !first.contains("\\t")) {
                    throw new IOException("文件不是 Netscape cookies.txt 格式");
                }
                if (!temporary.renameTo(cookieFile())) {
                    java.nio.file.Files.copy(temporary.toPath(), cookieFile().toPath(),
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                updateStatus("已导入本地 cookies.txt；仅用于 Instagram 视频请求，可随时清除。");
            } catch (Exception error) {
                updateStatus("Cookies 导入失败：" + friendlyError(error));
            } finally {
                temporary.delete();
            }
        });
    }

    private void clearCookieFile() {
        File file = cookieFile();
        if (file.exists() && !file.delete()) {
            updateStatus("清除失败，请重试或清除应用数据。");
        } else {
            updateStatus("Instagram Cookies 已清除。");
        }
    }

    private void configureExtractorRequest(YoutubeDLRequest request, String url) {
        request.addOption("--ignore-config");
        request.addOption("--socket-timeout", "15");
        request.addOption("--retries", "2");
        request.addOption("--extractor-retries", "1");
        request.addOption("--fragment-retries", "2");
        if (UrlTools.isInstagramVideoUrl(url) && cookieFile().isFile()) {
            request.addOption("--cookies", cookieFile().getAbsolutePath());
        }
    }

    private synchronized void appendLog(String line) {
        if (line == null || line.trim().isEmpty()) return;
        lastLog.append(line).append('\n');
        if (lastLog.length() > 12000) {
            lastLog.delete(0, lastLog.length() - 8000);
        }
    }

    private synchronized String diagnosticTail() {
        return InstagramDiagnostics.tail(lastLog.toString(), 2400);
    }

    private synchronized void resetLog() {
        lastLog.setLength(0);
    }

    private String runYtDlp(YoutubeDLRequest request, String taskId, boolean inspecting)
            throws Exception {
        checkMediaCancelled();
        timedOut.set(false);
        downloadStarted = false;
        commandStartMs = SystemClock.elapsedRealtime();
        lastActivityMs = commandStartMs;
        activeProcessId = taskId;
        runOnUiThread(() -> setButtons(true));
        ScheduledFuture<?> watchdog = timeoutWorker.scheduleAtFixedRate(() -> {
            if (!taskId.equals(activeProcessId) || timedOut.get()) return;
            long now = SystemClock.elapsedRealtime();
            boolean initialTimeout = !downloadStarted && now - commandStartMs > EXTRACT_TIMEOUT_MS;
            boolean stalled = downloadStarted && now - lastActivityMs > STALL_TIMEOUT_MS;
            if (cancelled.get() || initialTimeout || stalled) {
                if (!cancelled.get()) {
                    timedOut.set(true);
                    updateStatus("yt-dlp 响应超时，正在中止任务…");
                }
                try {
                    YoutubeDL.getInstance().destroyProcessById(taskId);
                } catch (Exception ignored) {
                    // The process may already have exited.
                }
            }
        }, 5, 5, TimeUnit.SECONDS);
        try {
            String result = YoutubeDL.getInstance().execute(request, taskId,
                    (Float progress, Long eta, String line) -> {
                        if (line != null && !line.isEmpty()) {
                            appendLog(line);
                            lastActivityMs = SystemClock.elapsedRealtime();
                            if (line.contains("[download]")) downloadStarted = true;
                            final String status = line;
                            final int percent = Math.min(100, Math.max(0, Math.round(progress)));
                            runOnUiThread(() -> {
                                if (cancelled.get()) return;
                                if (status.contains("[download]")) {
                                    progressBar.setProgress(percent);
                                    statusText.setText("下载中：" + percent + "%");
                                } else if (status.contains("Downloading") ||
                                        status.contains("Setting up session") ||
                                        status.contains("Extracting URL")) {
                                    statusText.setText(inspecting ? "解析中：" +
                                            InstagramDiagnostics.tail(status, 130)
                                            : "准备下载：" + InstagramDiagnostics.tail(status, 130));
                                }
                            });
                        }
                        return Unit.INSTANCE;
                    }).getOut();
            if (timedOut.get()) throw new IOException("yt-dlp 请求超时");
            if (cancelled.get()) throw new IOException("下载已取消");
            return result;
        } finally {
            watchdog.cancel(false);
            if (taskId.equals(activeProcessId)) activeProcessId = "";
        }
    }

    private void publishDownload(File source) throws IOException {
        String name = source.getName().replaceAll("[^a-zA-Z0-9._-]", "_");
        if (name.isEmpty()) name = "download-" + System.currentTimeMillis() + ".mp4";
        String mime = name.toLowerCase(Locale.ROOT).endsWith(".mp4") ? "video/mp4"
                : name.toLowerCase(Locale.ROOT).endsWith(".mkv") ? "video/x-matroska"
                : name.toLowerCase(Locale.ROOT).endsWith(".webm") ? "video/webm"
                : "application/octet-stream";
        ContentValues metadata = new ContentValues();
        metadata.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        metadata.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        metadata.put(MediaStore.MediaColumns.RELATIVE_PATH, DownloadFolder.RELATIVE_PATH);
        metadata.put(MediaStore.MediaColumns.IS_PENDING, 1);
        ContentResolver resolver = getContentResolver();
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, metadata);
        if (uri == null) throw new IOException("系统拒绝创建下载文件");
        boolean success = false;
        try {
            try (InputStream in = new FileInputStream(source);
                 OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("系统无法打开下载文件");
                byte[] buffer = new byte[128 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (cancelled.get()) throw new IOException("用户取消下载");
                    out.write(buffer, 0, read);
                }
            }
            metadata.clear();
            metadata.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, metadata, null, null);
            success = true;
        } finally {
            if (!success) resolver.delete(uri, null, null);
        }
    }

    private void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        // Only process-owned paths under the app's private external files directory.
        file.delete();
    }

    private String friendlyMediaError(String url, Exception error) {
        String detail = friendlyError(error);
        if (!UrlTools.isInstagramVideoUrl(url)) {
            return timedOut.get() ? "请求超时，请检查网络和解析器状态。" : detail;
        }
        return InstagramDiagnostics.summarize(detail + "\n" + diagnosticTail(), timedOut.get());
    }

    private void showFailureLog(Exception error) {
        String log = InstagramDiagnostics.tail(friendlyError(error) + "\n" + diagnosticTail(), 3200);
        updateDetails("诊断日志（可长按复制）\n" + log +
                "\n\nCSRF 警告本身不代表最终原因。若提示登录要求，可手动导入本人账户 cookies.txt。");
    }

    private String friendlyError(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return error.getClass().getSimpleName();
        return InstagramDiagnostics.tail(message, 1400);
    }

    @Override
    protected void onDestroy() {
        if (busy) cancelDownload();
        worker.shutdownNow();
        timeoutWorker.shutdownNow();
        super.onDestroy();
    }
}
