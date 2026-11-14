package com.newbie7666.netpandownload.mobile;

/** Public Downloads subfolder used by both the writer and the local folder browser. */
public final class DownloadFolder {
    public static final String RELATIVE_PATH = "Download/NetPanDownload/";

    private DownloadFolder() {}

    public static boolean contains(String path) {
        if (path == null) return false;
        String normalized = path.replace('\\', '/');
        if (!normalized.endsWith("/")) normalized += "/";
        return RELATIVE_PATH.equals(normalized);
    }
}
