package com.newbie7666.netpandownload.spidergateway;

import java.net.URI;
import java.util.Locale;

/** Wire contract shared with NetPanDownload's Windows type3-gateway client. */
public final class GatewayContract {
    public static final int PORT = 18778;
    public static final int MAX_REQUEST_BYTES = 256 * 1024;
    public static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    private GatewayContract() {}

    public static final class JarSpec {
        public final URI uri;
        public final String md5;
        JarSpec(URI uri, String md5) { this.uri = uri; this.md5 = md5; }
    }

    public static JarSpec parseJar(String raw) {
        if (raw == null || raw.length() > 4096) throw new IllegalArgumentException("Missing Spider jar");
        String value = raw.trim();
        int separator = value.toLowerCase(Locale.ROOT).indexOf(";md5;");
        String address = separator < 0 ? value : value.substring(0, separator);
        String md5 = separator < 0 ? "" : value.substring(separator + 5).toLowerCase(Locale.ROOT);
        if (!md5.isEmpty() && !md5.matches("[0-9a-f]{32}"))
            throw new IllegalArgumentException("Invalid Spider jar MD5");
        URI uri;
        try { uri = URI.create(address); }
        catch (IllegalArgumentException e) { throw new IllegalArgumentException("Invalid Spider jar URI"); }
        if (!"https".equalsIgnoreCase(uri.getScheme()) ||
            uri.getHost() == null || uri.getHost().isEmpty() ||
            uri.getUserInfo() != null || uri.getFragment() != null)
            throw new IllegalArgumentException("Spider jar requires an HTTPS URL without credentials");
        return new JarSpec(uri, md5);
    }

    public static String spiderClassName(String api) {
        if (api == null || !api.matches("csp_[A-Za-z0-9_.$]+"))
            throw new IllegalArgumentException("Invalid csp_* Spider class");
        String name = api.substring(4);
        return name.contains(".") ? name : "com.github.catvod.spider." + name;
    }
}
