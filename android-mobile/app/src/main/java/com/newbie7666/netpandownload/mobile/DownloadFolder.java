package com.newbie7666.netpandownload.mobile;

/** Public Downloads subfolder used by both the writer and the local folder browser. */
public final class DownloadFolder {
    public static final String RELATIVE_PATH = "Download/NetPanDownload/";

    private DownloadFolder() {}

    /** Android DocumentsProvider IDs from ACTION_OPEN_DOCUMENT_TREE, not raw file URLs. */
    public static boolean isExpectedTreeDocumentId(String documentId) {
        if (documentId == null) return false;
        String normalized = documentId.replace('\\', '/').replaceAll("/+$", "");
        return normalized.equals("primary:Download/NetPanDownload");
    }

    public static boolean contains(String path) {
        if (path == null) return false;
        String normalized = path.replace('\\', '/');
        if (!normalized.endsWith("/")) normalized += "/";
        return RELATIVE_PATH.equals(normalized);
    }
}
