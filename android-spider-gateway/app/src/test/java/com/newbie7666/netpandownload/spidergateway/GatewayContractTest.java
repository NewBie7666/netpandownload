package com.newbie7666.netpandownload.spidergateway;

import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayContractTest {
    @Test public void parsesVersionedHttpsJarAndDigest() {
        GatewayContract.JarSpec result = GatewayContract.parseJar(
                "https://example.org/wex.zip.jpg;md5;0123456789ABCDEF0123456789abcdef");
        assertEquals("https://example.org/wex.zip.jpg", result.uri.toString());
        assertEquals("0123456789abcdef0123456789abcdef", result.md5);
    }

    @Test public void rejectsUntrustedJarSchemesAndCredentials() {
        for (String invalid : new String[] {
                "http://example.org/spider.jar",
                "https://user:password@example.org/spider.jar",
                "https://example.org/spider.jar#fragment",
                "file:///data/user/0/spider.jar",
                "https://example.org/spider.jar;md5;broken"
        }) {
            try {
                GatewayContract.parseJar(invalid);
                fail("Accepted unsafe Jar URL: " + invalid);
            } catch (IllegalArgumentException expected) {
                // Expected.
            }
        }
    }

    @Test public void httpJarIsOptInNotDefault() {
        String url = "http://example.org/spider.jar;md5;0123456789abcdef0123456789abcdef";
        try {
            GatewayContract.parseJar(url);
            fail("HTTP Spider JAR must be disabled by default");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("http"));
        }
        GatewayContract.JarSpec allowed = GatewayContract.parseJar(url, true);
        assertEquals("http://example.org/spider.jar", allowed.uri.toString());
        assertEquals("0123456789abcdef0123456789abcdef", allowed.md5);
    }

    @Test public void httpOptInStillRejectsLocalAndCredentialedUrls() {
        for (String invalid : new String[]{
            "http://127.0.0.1/spider.jar",
            "http://localhost/spider.jar",
            "http://host.local/spider.jar",
            "http://user:pass@example.org/spider.jar",
            "http://example.org/spider.jar#fragment",
            "file:///sdcard/spider.jar"
        }) {
            try {
                GatewayContract.parseJar(invalid, true);
                fail("Accepted unsafe URL: " + invalid);
            } catch (IllegalArgumentException expected) {}
        }
    }

    @Test public void mapsSafeCspClassNames() {
        assertEquals("com.github.catvod.spider.WexAiJianPianGuard",
                GatewayContract.spiderClassName("csp_WexAiJianPianGuard"));
        assertEquals("com.github.catvod.spider.Demo",
                GatewayContract.spiderClassName("csp_com.github.catvod.spider.Demo"));
        for (String invalid : new String[] {"notspider", "csp_", "csp_Foo/../../Bar", "csp_Bar;rm"}) {
            try {
                GatewayContract.spiderClassName(invalid);
                fail("Accepted invalid class name: " + invalid);
            } catch (IllegalArgumentException expected) {}
        }
    }
}
