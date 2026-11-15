package com.newbie7666.netpandownload.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class InstagramDiagnosticsTest {
    @Test public void classifiesLoginRequiredAndCsrfWarning() {
        String raw = "WARNING: No csrf token set by Instagram API\n" +
                "ERROR: Requested content is not available, rate-limit reached or login required";
        assertTrue(InstagramDiagnostics.summarize(raw, false).contains("限流"));
        assertTrue(InstagramDiagnostics.summarize("ERROR: login required. Use --cookies", false).contains("登录"));
        assertTrue(InstagramDiagnostics.summarize("WARNING: No csrf token set by Instagram API", false)
                .contains("警告而非独立"));
    }
    @Test public void detectsHttpAndExtractorErrors() {
        assertTrue(InstagramDiagnostics.summarize("HTTP Error 403", false).contains("拒绝"));
        assertTrue(InstagramDiagnostics.summarize("Unable to extract data", false).contains("提取器"));
        assertTrue(InstagramDiagnostics.summarize("Requested format is not available", false).contains("视频格式"));
    }
    @Test public void timeoutIsClearAndLogRetainsTail() {
        assertTrue(InstagramDiagnostics.summarize("ERROR: unknown", true).contains("解析超时"));
        assertTrue(InstagramDiagnostics.tail("0123456789", 7).endsWith("56789"));
        assertEquals("", InstagramDiagnostics.tail(null, 200));
    }
}
