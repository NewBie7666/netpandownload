package com.newbie7666.netpandownload.mobile;

import java.util.Locale;

/** Pure, testable diagnostics for Instagram extraction failures. */
public final class InstagramDiagnostics {
    private InstagramDiagnostics() {}

    public static String summarize(String output, boolean timedOut) {
        if (timedOut) {
            return "解析超时（120 秒未开始下载，或下载后 90 秒无进展）。可检查网络、更新 yt-dlp 后重试。";
        }
        String text = output == null ? "" : output;
        String lower = text.toLowerCase(Locale.ROOT);
        if (lower.contains("rate-limit") || lower.contains("rate limit") ||
                lower.contains("http error 429") || lower.contains("error 429")) {
            return "Instagram 限流（429 / rate limit）。请过一段时间再试，避免频繁重试。";
        }
        if (lower.contains("login required") || lower.contains("login to") ||
                lower.contains("cookies for the authentication") ||
                lower.contains("private account") || lower.contains("not logged in") ||
                lower.contains("locked behind the login")) {
            return "Instagram 要求登录或当前内容不可匿名访问。可尝试从浏览器导入本人账户的 Netscape cookies.txt。";
        }
        if (lower.contains("http error 403") || lower.contains("error 403") ||
                lower.contains("access denied") || lower.contains("empty media response")) {
            return "Instagram 拒绝访问或返回空媒体。请检查网络、公开状态及登录会话。";
        }
        if (lower.contains("requested format is not available") ||
                lower.contains("no video formats") || lower.contains("no video file")) {
            return "未找到可下载的视频格式；帖子可能只有图片或网站更改了视频格式。";
        }
        if (lower.contains("unable to extract") || lower.contains("extractor error")) {
            return "Instagram 提取器解析失败。请先更新 yt-dlp，再检查是否需要登录。";
        }
        if (lower.contains("no csrf token")) {
            return "Instagram 未提供 CSRF token（这是警告而非独立的失败原因）。请查看下方完整日志，必要时更新解析器或导入 cookies。";
        }
        return "解析或下载失败。请查看下方日志，更新 yt-dlp 并核实该 Reel 是否无需登录可播放。";
    }

    public static String tail(String value, int maxCharacters) {
        if (value == null || value.isEmpty() || maxCharacters <= 0) return "";
        if (value.length() <= maxCharacters) return value;
        return "…\n" + value.substring(value.length() - Math.max(1, maxCharacters - 2));
    }
}
