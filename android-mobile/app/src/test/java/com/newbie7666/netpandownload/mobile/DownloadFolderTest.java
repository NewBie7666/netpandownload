package com.newbie7666.netpandownload.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class DownloadFolderTest {
    @Test public void onlyAllowTheActualDownloadSubfolder() {
        assertTrue(DownloadFolder.isExpectedTreeDocumentId("primary:Download/NetPanDownload"));
        assertTrue(DownloadFolder.isExpectedTreeDocumentId("primary:Download/NetPanDownload/"));
        assertFalse(DownloadFolder.isExpectedTreeDocumentId("primary:Download"));
        assertFalse(DownloadFolder.isExpectedTreeDocumentId("primary:Download/Other"));
        assertFalse(DownloadFolder.isExpectedTreeDocumentId("primary:Download/NetPanDownloadExtra"));
        assertFalse(DownloadFolder.isExpectedTreeDocumentId("primary:Android/data"));
        assertFalse(DownloadFolder.isExpectedTreeDocumentId(null));
    }

    @Test public void matchesThePublicDownloadDestination() {
        assertEquals("Download/NetPanDownload/", DownloadFolder.RELATIVE_PATH);
        assertTrue(DownloadFolder.contains("Download/NetPanDownload/"));
        assertTrue(DownloadFolder.contains("Download/NetPanDownload"));
        assertFalse(DownloadFolder.contains("Download/"));
        assertFalse(DownloadFolder.contains("Download/NetPanDownload-other/"));
        assertFalse(DownloadFolder.contains(null));
    }
}
