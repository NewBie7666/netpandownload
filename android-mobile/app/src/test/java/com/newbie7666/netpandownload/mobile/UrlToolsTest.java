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

    @Test public void acceptsInstagramPublicVideoLinks() {
        assertEquals("Instagram", UrlTools.category("https://www.instagram.com/reel/C0Ab_-12/?igsh=a1"));
        assertEquals("Instagram", UrlTools.category("https://instagram.com/p/CAB1234/"));
        assertEquals("Instagram", UrlTools.category("https://m.instagram.com/tv/AbCD_987"));
        assertTrue(UrlTools.supportsDownload("www.instagram.com/reel/C0Ab_-12/"));
        assertTrue(UrlTools.isInstagramVideoUrl("https://www.instagram.com/p/abc123"));
    }

    @Test public void stripsInstagramShareTracking() {
        assertEquals("https://www.instagram.com/reel/C0Ab_-12/",
                UrlTools.normalize("https://www.instagram.com/reel/C0Ab_-12/?igsh=tracking"));
        assertEquals("https://www.instagram.com/reel/ABC123/",
                UrlTools.normalize("分享给你 https://www.instagram.com/reel/ABC123/?utm_source=ig_web_copy_link 看看"));
        assertEquals("https://instagram.com/p/XYZ123",
                UrlTools.normalize("instagram.com/p/XYZ123"));
    }

    @Test public void rejectsInstagramProfilesStoriesAndSpoofs() {
        for (String input : new String[]{
                "https://www.instagram.com/username/",
                "https://www.instagram.com/stories/username/12345/",
                "https://www.instagram.com/reels/",
                "https://www.instagram.com/reel/",
                "https://help.instagram.com/p/ABC123/",
                "https://instagram.com.evil.example/reel/ABC123",
                "https://www.instagram.com:8443/reel/ABC123",
                "https://www.instagram.com@evil.example/reel/ABC123"
        }) {
            assertFalse(input, UrlTools.supportsDownload(input));
        }
        assertEquals("不支持的 Instagram 链接",
                UrlTools.category("https://www.instagram.com/stories/user/123"));
    }

    @Test public void instagramUsesMuxedMp4AndOnlyKeepsVideoFiles() {
        assertTrue(UrlTools.preferredFormat("https://instagram.com/reel/AB12").startsWith("best[ext=mp4]"));
        assertEquals("bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
                UrlTools.preferredFormat("https://youtube.com/watch?v=abc"));
        assertTrue(UrlTools.isVideoFilename("Instagram-XYZ-001.MP4"));
        assertTrue(UrlTools.isVideoFilename("clip.webm"));
        assertFalse(UrlTools.isVideoFilename("photo.jpg"));
        assertFalse(UrlTools.isVideoFilename("partial.mp4.part"));
    }

    @Test public void supportsOtherPublicProviders() {
        assertTrue(UrlTools.supportsDownload("https://www.bilibili.com/video/BV123"));
        assertTrue(UrlTools.supportsDownload("https://www.youtube.com/watch?v=abc"));
    }
}
