package com.newbie7666.netpandownload.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class UrlToolsTest {
    @Test public void acceptsTweet() {
        assertEquals("X / Twitter", UrlTools.category("https://x.com/user/status/1234567?s=20"));
        assertEquals("X / Twitter", UrlTools.category("twitter.com/user/status/1234567"));
    }

    @Test public void acceptsSharedText() {
        assertEquals("https://x.com/user/status/123", UrlTools.normalize(
                "看看这个 https://x.com/user/status/123  好看"));
    }

    @Test public void rejectsUnsupportedAndLocal() {
        assertFalse(UrlTools.supportsDownload("file:///etc/passwd"));
        assertFalse(UrlTools.supportsDownload("https://x.com/search?q=hello"));
        assertFalse(UrlTools.supportsDownload("https://pan.quark.cn/s/abcdef"));
        assertFalse(UrlTools.supportsDownload("https://x.com.evil.example/not-a-tweet"));
    }

    @Test public void supportsOtherPublicProviders() {
        assertTrue(UrlTools.supportsDownload("https://www.bilibili.com/video/BV123"));
        assertTrue(UrlTools.supportsDownload("https://www.youtube.com/watch?v=abc"));
    }
}
