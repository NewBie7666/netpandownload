package com.newbie7666.netpandownload.mobile;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class UrlTools {
    private static final Pattern LINK = Pattern.compile("https?://[^\\s<>\\\"']+", Pattern.CASE_INSENSITIVE);
    private static final Pattern X_POST = Pattern.compile(
            "^/(?:(?:[a-zA-Z0-9_]{1,15}|i)/status|i/web/status)/[0-9]+(?:/(?:video|photo)/[0-9]+)?/?$",
            Pattern.CASE_INSENSITIVE
    );

    private UrlTools() {}

    public static String normalize(String raw) {
        String input = raw == null ? "" : raw.trim();
        if (input.matches("(?i)^(?:(?:www|mobile)\\.)?(?:x\\.com|twitter\\.com|bilibili\\.com|youtu\\.be|youtube\\.com)/.*")) {
            input = "https://" + input;
        } else {
            Matcher matcher = LINK.matcher(input);
            if (matcher.find()) input = matcher.group();
        }
        try {
            URI uri = new URI(input);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || uri.getUserInfo() != null ||
                    !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http"))) {
                return "";
            }
            if (uri.getPort() != -1) return "";
            return uri.toString();
        } catch (URISyntaxException | IllegalArgumentException ignored) {
            return "";
        }
    }

    public static String category(String rawUrl) {
        String url = normalize(rawUrl);
        if (url.isEmpty()) return "无效链接";
        try {
            URI uri = new URI(url);
            String host = uri.getHost().toLowerCase();
            if (host.equals("x.com") || host.endsWith(".x.com") ||
                    host.equals("twitter.com") || host.endsWith(".twitter.com")) {
                return X_POST.matcher(uri.getPath()).matches() ? "X / Twitter" : "不支持的 X 链接";
            }
            if (host.equals("bilibili.com") || host.endsWith(".bilibili.com") || host.equals("b23.tv")) {
                return "Bilibili";
            }
            if (host.equals("youtube.com") || host.endsWith(".youtube.com") || host.equals("youtu.be")) {
                return "YouTube";
            }
            if (host.equals("pan.quark.cn")) return "夸克网盘暂未移植到 Android";
            return "其他 yt-dlp 支持的公开网站";
        } catch (URISyntaxException ignored) {
            return "无效链接";
        }
    }

    public static boolean supportsDownload(String rawUrl) {
        String category = category(rawUrl);
        return !category.equals("无效链接") &&
               !category.equals("不支持的 X 链接") &&
               !category.equals("夸克网盘暂未移植到 Android");
    }
}
