package com.newbie7666.netpandownload.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentUris;
import android.content.ClipData;
import android.content.UriPermission;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.DocumentsContract;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Shows the exact folder where downloads are stored.
 * For historical files no longer owned by this installation, uses one-time
 * Android Storage Access Framework folder consent instead of broad storage permissions.
 */
public final class DownloadFolderActivity extends Activity {
    private static final int REQUEST_FOLDER_TREE = 8601;
    private static final String FOLDER_PREF = "selected_download_folder_tree";
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
        // Android restricts reading Downloads from an older installation. Explain
        // the initial, one-time folder consent instead of incorrectly saying empty.
        if (state == null && getGrantedFolderUri() == null) {
            fileList.post(this::explainFirstTimeAccess);
        }
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

        Button grantButton = new Button(this);
        grantButton.setText("选择下载文件夹（授权读取旧文件）");
        grantButton.setOnClickListener(v -> requestFolderAccess());
        LinearLayout.LayoutParams grantParams = new LinearLayout.LayoutParams(-1, -2);
        grantParams.topMargin = dp(6);
        root.addView(grantButton, grantParams);

        fileList = new LinearLayout(this);
        fileList.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams listParams = new LinearLayout.LayoutParams(-1, -2);
        listParams.topMargin = dp(12);
        root.addView(fileList, listParams);

        TextView hint = label(
                "文件位于 Download/NetPanDownload。首次请授权这个子文件夹（不要选择 Download 根目录）。授权后可读取之前安装版本保存的视频；点击文件即可打开。",
                13, Color.rgb(96, 109, 128));
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(-1, -2);
        hintParams.topMargin = dp(18);
        root.addView(hint, hintParams);

        setContentView(scroll);
    }


    private Uri getGrantedFolderUri() {
        String saved = getPreferences(MODE_PRIVATE).getString(FOLDER_PREF, null);
        if (saved == null || saved.isEmpty()) return null;
        for (UriPermission grant : getContentResolver().getPersistedUriPermissions()) {
            if (grant.isReadPermission() && saved.equals(grant.getUri().toString())) {
                return grant.getUri();
            }
        }
        return null;
    }

    private void explainFirstTimeAccess() {
        if (isFinishing() || isDestroyed() || getGrantedFolderUri() != null) return;
        new AlertDialog.Builder(this)
                .setTitle("读取已有下载文件")
                .setMessage("Android 可能不允许新安装版本直接读取旧版保存的文件。"
                        + "请在系统文件选择器中进入 内部存储 / Download / NetPanDownload，"
                        + "选择 NetPanDownload 文件夹并确认授权。只需授权一次，之后直接打开文件列表。")
                .setPositiveButton("选择文件夹", (dialog, which) -> requestFolderAccess())
                .setNegativeButton("暂不授权", null)
                .show();
    }

    private void requestFolderAccess() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION |
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        // This points to a *subfolder*, not the Android 11+ restricted Download root.
        // A provider may ignore the initial URI, so the user can still navigate manually.
        try {
            Uri initial = DocumentsContract.buildDocumentUri(
                    "com.android.externalstorage.documents", "primary:Download/NetPanDownload");
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial);
        } catch (IllegalArgumentException ignored) {
            // The picker can still be opened without an initial folder.
        }
        try {
            startActivityForResult(intent, REQUEST_FOLDER_TREE);
        } catch (Exception error) {
            stateLabel.setText("系统文件夹选择器不可用。请在文件管理器中查看 Download/NetPanDownload。");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FOLDER_TREE || resultCode != RESULT_OK || data == null) return;
        Uri selected = data.getData();
        if (selected == null) return;
        String directoryId;
        try {
            directoryId = DocumentsContract.getTreeDocumentId(selected);
        } catch (IllegalArgumentException error) {
            stateLabel.setText("文件夹无效，请选择 Download/NetPanDownload。");
            return;
        }
        if (!DownloadFolder.isExpectedTreeDocumentId(directoryId)) {
            stateLabel.setText("选错文件夹了：请进入 Download，再选 NetPanDownload 子文件夹。");
            return;
        }
        try {
            getContentResolver().takePersistableUriPermission(selected, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getPreferences(MODE_PRIVATE).edit().putString(FOLDER_PREF, selected.toString()).apply();
            stateLabel.setText("文件夹访问已授权，正在读取全部文件……");
            refresh();
        } catch (SecurityException error) {
            stateLabel.setText("系统未授予读取权限，请重新选择 NetPanDownload 文件夹。");
        }
    }

    private List<DownloadFile> listFilesFromTree(Uri tree) {
        List<DownloadFile> files = new ArrayList<>();
        String folderId = DocumentsContract.getTreeDocumentId(tree);
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, folderId);
        String[] projection = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
        };
        class DatedFile {
            final DownloadFile file;
            final long modified;
            DatedFile(DownloadFile file, long modified) {
                this.file = file;
                this.modified = modified;
            }
        }
        List<DatedFile> dated = new ArrayList<>();
        try (Cursor cursor = getContentResolver().query(childrenUri, projection, null, null, null)) {
            if (cursor == null) {
                throw new IllegalStateException("系统未返回文件夹内容，请重新授权");
            }
            int idColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            int mimeColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE);
            int sizeColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE);
            int modifiedColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
            while (cursor.moveToNext()) {
                String mime = cursor.getString(mimeColumn);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) continue;
                String id = cursor.getString(idColumn);
                if (id == null) continue;
                Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                String name = cursor.getString(nameColumn);
                long size = cursor.isNull(sizeColumn) ? 0 : cursor.getLong(sizeColumn);
                long modified = cursor.isNull(modifiedColumn) ? 0 : cursor.getLong(modifiedColumn);
                dated.add(new DatedFile(new DownloadFile(fileUri, name == null ? "(未命名文件)" : name,
                        mime == null || mime.isEmpty() ? "*/*" : mime, size), modified));
            }
        }
        dated.sort((left, right) -> Long.compare(right.modified, left.modified));
        for (DatedFile entry : dated) files.add(entry.file);
        return files;
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
            Uri folderGrant = getGrantedFolderUri();
            List<DownloadFile> files = null;
            String error = null;
            try {
                files = folderGrant == null ? listFiles() : listFilesFromTree(folderGrant);
            } catch (Exception exception) {
                error = exception.getMessage();
            }
            final List<DownloadFile> finalFiles = files;
            final String finalError = error;
            final boolean hasFolderAccess = folderGrant != null;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || version != requestVersion) return;
                fileList.removeAllViews();
                if (finalError != null) {
                    stateLabel.setText("读取失败：" + finalError + "。请重新选择下载文件夹授权。");
                    return;
                }
                if (finalFiles == null || finalFiles.isEmpty()) {
                    stateLabel.setText(hasFolderAccess
                            ? "已获文件夹授权，但该目录暂未发现文件。"
                            : "尚未获得历史文件的读取权限。请点击「选择下载文件夹」，选择 Download/NetPanDownload；不能据此认定文件不存在。");
                    return;
                }
                stateLabel.setText("共有 " + finalFiles.size() + " 个文件" +
                        (hasFolderAccess ? "（来自实际下载文件夹）" : "（仅当前安装可见，请授权以查看旧文件）"));
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
        intent.setClipData(ClipData.newRawUri("NetPanDownload file", file.uri));
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
