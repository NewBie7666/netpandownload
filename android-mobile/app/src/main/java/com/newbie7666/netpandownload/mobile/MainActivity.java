package com.newbie7666.netpandownload.mobile;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
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

import com.yausername.youtubedl_android.FFmpeg;
import com.yausername.youtubedl_android.VideoInfo;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import kotlin.Unit;
import kotlin.jvm.functions.Function3;

/**
 * Standalone downloader. No Express, Electron, LAN service or cloud parser.
 * yt-dlp/FFmpeg run locally and completed files are published through MediaStore.
 */
public final class MainActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelled = new AtomicBoolean(false);

    private EditText linkField;
    private TextView statusText;
    private TextView detailsText;
    private ProgressBar progressBar;
    private Button inspectButton;
    private Button downloadButton;
    private Button cancelButton;
    private volatile boolean busy;
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
                updateStatus("本地解析器就绪，可以粘贴视频链接。");
                runOnUiThread(() -> setButtons(false));
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

        TextView urlLabel = text("视频链接", 16, Color.rgb(30, 40, 55));
        content.addView(urlLabel);

        linkField = new EditText(this);
        linkField.setTextSize(15);
        linkField.setMinLines(2);
        linkField.setMaxLines(4);
        linkField.setGravity(Gravity.TOP);
        linkField.setHint("粘贴 X/Twitter、B站、YouTube 视频地址");
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

        detailsText = text("支持公开 X 帖子、B站和 YouTube 等 yt-dlp 可解析资源。\n\n文件保存到 下载/NetPanDownload。\n需要登录的媒体及夸克网盘链接暂不支持。\n当前任务需保持应用运行。", 14, Color.rgb(96, 109, 128));
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2);
        detailParams.topMargin = dp(16);
        content.addView(detailsText, detailParams);

        Button openDownloads = new Button(this);
        openDownloads.setText("打开系统下载列表");
        openDownloads.setOnClickListener(v -> {
            try {
                startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
            } catch (Exception error) {
                Toast.makeText(this, "请在文件管理器中打开 Download/NetPanDownload", Toast.LENGTH_LONG).show();
            }
        });
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
        cancelButton.setEnabled(isBusy);
    }

    private void setBusy(boolean value) {
        busy = value;
        runOnUiThread(() -> setButtons(value));
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
        setBusy(true);
        updateStatus("正在使用手机本地解析视频信息……");
        worker.execute(() -> {
            try {
                VideoInfo info = YoutubeDL.getInstance().getInfo(url);
                String title = info.getTitle();
                updateDetails("来源：" + UrlTools.category(url) + "\n标题：" + (title == null ? "(无标题)" : title) +
                        "\n\n按「下载视频到手机」保存媒体。");
                updateStatus("解析完成。");
            } catch (Exception error) {
                updateStatus("解析失败：" + friendlyError(error));
            } finally {
                setBusy(false);
            }
        });
    }

    private void startDownload() {
        if (busy || !ready) return;
        String url = checkedUrl();
        if (url == null) return;
        closeKeyboard();
        cancelled.set(false);
        setBusy(true);
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
        activeProcessId = taskId;
        try {
            File root = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (root == null) throw new IOException("手机存储不可用");
            stage = new File(root, "temp-" + taskId);
            if (!stage.mkdirs()) throw new IOException("无法创建临时文件夹");

            YoutubeDLRequest request = new YoutubeDLRequest(url);
            request.addOption("--ignore-config");
            request.addOption("--no-mtime");
            request.addOption("--yes-playlist");
            request.addOption("--merge-output-format", "mp4");
            request.addOption("--no-overwrites");
            request.addOption("-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best");
            request.addOption("-o", new File(stage, "%(extractor_key)s-%(id)s-%(autonumber)03d.%(ext)s").getAbsolutePath());

            Function3<Float, Long, String, Unit> callback = (value, eta, line) -> {
                final int progress = Math.min(100, Math.max(0, Math.round(value)));
                runOnUiThread(() -> {
                    progressBar.setProgress(progress);
                    if (line != null && line.contains("[download]")) {
                        statusText.setText("手机本地下载中：" + progress + "%");
                    }
                });
                return Unit.INSTANCE;
            };

            YoutubeDL.getInstance().execute(request, taskId, callback);
            if (cancelled.get()) return;

            File[] outputs = stage.listFiles();
            int saved = 0;
            if (outputs != null) {
                for (File item : outputs) {
                    if (cancelled.get()) return;
                    if (item.isFile() && item.length() > 0 &&
                            !item.getName().endsWith(".part") &&
                            !item.getName().endsWith(".ytdl")) {
                        publishDownload(item);
                        saved++;
                    }
                }
            }
            if (saved == 0) throw new IOException("解析成功，但没有找到完整视频文件");
            final int total = saved;
            runOnUiThread(() -> progressBar.setProgress(100));
            updateStatus("下载完成，已保存 " + total + " 个文件到 Download/NetPanDownload");
            updateDetails("下载成功。请在手机文件管理器的 Download/NetPanDownload 目录中查看。");
        } catch (Exception error) {
            if (cancelled.get()) updateStatus("下载已取消。");
            else updateStatus("下载失败：" + friendlyError(error));
        } finally {
            activeProcessId = "";
            if (stage != null) deleteTree(stage);
            setBusy(false);
        }
    }

    private void cancelDownload() {
        if (!busy) return;
        cancelled.set(true);
        updateStatus("正在取消下载……");
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
        metadata.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/NetPanDownload");
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

    private String friendlyError(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return error.getClass().getSimpleName();
        if (message.length() > 320) return message.substring(0, 320);
        return message;
    }

    @Override
    protected void onDestroy() {
        if (busy) cancelDownload();
        worker.shutdownNow();
        super.onDestroy();
    }
}
