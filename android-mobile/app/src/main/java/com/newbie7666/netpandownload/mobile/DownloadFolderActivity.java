package com.newbie7666.netpandownload.mobile;

import android.app.Activity;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Shows the exact folder where the app saves completed downloads.
 * Uses MediaStore (Android 10+) so it does not need broad storage permissions.
 */
public final class DownloadFolderActivity extends Activity {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private LinearLayout fileList;
    private TextView stateLabel;
    private int requestVersion = 0;

    private static final class DownloadFile {
        final Uri uri;
        final String name;
        final String mime;
        final long size;

        DownloadFile(Uri uri, String name, String mime, long size) {
            this.uri = uri;
            this.name = name;
            this.mime = mime;
            this.size = size;
        }
    }

    private int dp(float value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    private TextView label(String text, int size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        buildScreen();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void buildScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(247, 249, 252));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(28));
        scroll.addView(root);

        Button back = new Button(this);
        back.setText("返回下载器");
        back.setOnClickListener(v -> finish());
        root.addView(back, new LinearLayout.LayoutParams(-1, -2));

        TextView heading = label("下载文件夹", 26, Color.rgb(20, 31, 50));
        heading.setTypeface(null, 1);
        LinearLayout.LayoutParams headParams = new LinearLayout.LayoutParams(-1, -2);
        headParams.topMargin = dp(16);
        root.addView(heading, headParams);

        TextView location = label("手机存储 / Download / NetPanDownload", 14, Color.rgb(84, 98, 118));
        LinearLayout.LayoutParams locationParams = new LinearLayout.LayoutParams(-1, -2);
        locationParams.topMargin = dp(8);
        root.addView(location, locationParams);

        stateLabel = label("正在读取文件……", 14, Color.rgb(84, 98, 118));
        LinearLayout.LayoutParams stateParams = new LinearLayout.LayoutParams(-1, -2);
        stateParams.topMargin = dp(20);
        root.addView(stateLabel, stateParams);

        Button refreshButton = new Button(this);
        refreshButton.setText("刷新文件列表");
        refreshButton.setOnClickListener(v -> refresh());
        LinearLayout.LayoutParams refreshParams = new LinearLayout.LayoutParams(-1, -2);
        refreshParams.topMargin = dp(8);
        root.addView(refreshButton, refreshParams);

        fileList = new LinearLayout(this);
        fileList.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams listParams = new LinearLayout.LayoutParams(-1, -2);
        listParams.topMargin = dp(12);
        root.addView(fileList, listParams);

        TextView hint = label(
                "仅展示 NetPanDownload 保存的文件。点击文件可以调用手机的视频播放器或其他支持该格式的应用。",
                13, Color.rgb(96, 109, 128));
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(-1, -2);
        hintParams.topMargin = dp(18);
        root.addView(hint, hintParams);

        setContentView(scroll);
    }

    private List<DownloadFile> listFiles() {
        List<DownloadFile> files = new ArrayList<>();
        String[] projection = {
                MediaStore.Downloads._ID,
                MediaStore.Downloads.DISPLAY_NAME,
                MediaStore.Downloads.MIME_TYPE,
                MediaStore.Downloads.SIZE
        };
        String where = MediaStore.Downloads.RELATIVE_PATH + "=? AND " +
                MediaStore.Downloads.IS_PENDING + "=0";
        try (Cursor cursor = getContentResolver().query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                projection,
                where,
                new String[]{DownloadFolder.RELATIVE_PATH},
                MediaStore.Downloads.DATE_ADDED + " DESC")) {
            if (cursor == null) return files;
            int idIndex = cursor.getColumnIndexOrThrow(MediaStore.Downloads._ID);
            int nameIndex = cursor.getColumnIndexOrThrow(MediaStore.Downloads.DISPLAY_NAME);
            int mimeIndex = cursor.getColumnIndexOrThrow(MediaStore.Downloads.MIME_TYPE);
            int sizeIndex = cursor.getColumnIndexOrThrow(MediaStore.Downloads.SIZE);
            while (cursor.moveToNext()) {
                long id = cursor.getLong(idIndex);
                String name = cursor.getString(nameIndex);
                String mime = cursor.getString(mimeIndex);
                long size = cursor.isNull(sizeIndex) ? 0L : cursor.getLong(sizeIndex);
                Uri uri = ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id);
                files.add(new DownloadFile(uri, name == null ? "(未命名文件)" : name,
                        mime == null || mime.isEmpty() ? "*/*" : mime, size));
            }
        }
        return files;
    }

    private void refresh() {
        final int version = ++requestVersion;
        stateLabel.setText("正在读取 Download/NetPanDownload……");
        executor.execute(() -> {
            List<DownloadFile> files = null;
            String error = null;
            try {
                files = listFiles();
            } catch (Exception exception) {
                error = exception.getMessage();
            }
            final List<DownloadFile> finalFiles = files;
            final String finalError = error;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || version != requestVersion) return;
                fileList.removeAllViews();
                if (finalError != null) {
                    stateLabel.setText("无法读取下载文件夹：" + finalError);
                    return;
                }
                if (finalFiles == null || finalFiles.isEmpty()) {
                    stateLabel.setText("文件夹中暂无可读取的下载文件。");
                    return;
                }
                stateLabel.setText("共有 " + finalFiles.size() + " 个文件");
                for (DownloadFile file : finalFiles) addFileRow(file);
            });
        });
    }

    private String humanSize(long bytes) {
        if (bytes <= 0) return "大小未知";
        double value = bytes;
        String[] units = {"B", "KB", "MB", "GB"};
        int unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return String.format(Locale.getDefault(), "%.1f %s", value, units[unit]);
    }

    private void addFileRow(DownloadFile file) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setPadding(dp(14), dp(14), dp(14), dp(14));
        item.setBackgroundTintList(null);
        item.setBackgroundColor(Color.WHITE);

        TextView name = label(file.name, 16, Color.rgb(22, 36, 60));
        name.setTypeface(null, 1);
        name.setMaxLines(3);
        item.addView(name);

        TextView size = label(humanSize(file.size), 13, Color.rgb(91, 106, 124));
        LinearLayout.LayoutParams sizeParams = new LinearLayout.LayoutParams(-1, -2);
        sizeParams.topMargin = dp(6);
        item.addView(size, sizeParams);

        Button open = new Button(this);
        open.setText("打开文件");
        open.setGravity(Gravity.CENTER);
        open.setOnClickListener(v -> openFile(file));
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(-1, -2);
        buttonParams.topMargin = dp(6);
        item.addView(open, buttonParams);
        item.setOnClickListener(v -> openFile(file));

        LinearLayout.LayoutParams itemParams = new LinearLayout.LayoutParams(-1, -2);
        itemParams.bottomMargin = dp(10);
        fileList.addView(item, itemParams);
    }

    private void openFile(DownloadFile file) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(file.uri, file.mime);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(intent);
        } catch (Exception error) {
            Toast.makeText(this, "没有可以打开此文件的应用，或文件已被删除", Toast.LENGTH_LONG).show();
            refresh();
        }
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }
}
