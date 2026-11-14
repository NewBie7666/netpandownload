package com.newbie7666.netpandownload.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class DownloadFolderTest {
    @Test public void matchesThePublicDownloadDestination() {
        assertEquals("Download/NetPanDownload/", DownloadFolder.RELATIVE_PATH);
        assertTrue(DownloadFolder.contains("Download/NetPanDownload/"));
        assertTrue(DownloadFolder.contains("Download/NetPanDownload"));
        assertFalse(DownloadFolder.contains("Download/"));
        assertFalse(DownloadFolder.contains("Download/NetPanDownload-other/"));
        assertFalse(DownloadFolder.contains(null));
    }
}
