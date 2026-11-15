package com.newbie7666.netpandownload.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigInteger;
import java.net.URI;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Extracts video renditions belonging to a specific public Instagram post. */
final class InstagramPage {
    private static final Pattern SCRIPT = Pattern.compile(
            "<script\\b[^>]*\\sdata-sjs(?=[\\s=>])[^>]*>(.*?)</script\\s*>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final String SHORTCODE_ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    record Video(URI url, int position) {}
    record Post(String shortcode, String title, List<Video> videos) {}

    private InstagramPage() {}

    static Post parse(String html, String shortcode) {
        BigInteger id = BigInteger.ZERO;
        for (int i = 0; i < shortcode.length(); i++) {
            int digit = SHORTCODE_ALPHABET.indexOf(shortcode.charAt(i));
            if (digit < 0) return null;
            id = id.shiftLeft(6).add(BigInteger.valueOf(digit));
        }
        String mediaId = id.toString();
        Matcher scripts = SCRIPT.matcher(html);
        while (scripts.find()) {
            String json = scripts.group(1).trim();
            if (!json.startsWith("{") || !json.contains("video_versions") ||
                    !(json.contains(mediaId) || json.contains(shortcode))) continue;
            try {
                Post post = findPost(new JSONObject(json), shortcode, mediaId);
                if (post != null) return post;
            } catch (JSONException | StackOverflowError ignored) {
                // Each script is independent. Skip malformed or excessively nested JSON.
            }
        }
        return null;
    }

    private static Post findPost(JSONObject root, String shortcode, String mediaId) {
        ArrayDeque<Object> pending = new ArrayDeque<>();
        pending.add(root);
        while (!pending.isEmpty()) {
            Object value = pending.removeFirst();
            if (value instanceof JSONObject object) {
                if (matchesPost(object, shortcode, mediaId)) {
                    List<Video> videos = readVideos(object);
                    if (!videos.isEmpty()) {
                        JSONObject user = object.optJSONObject("user");
                        if (user == null) user = object.optJSONObject("owner");
                        String username = user == null ? "" : user.optString("username").trim();
                        return new Post(shortcode, username.isEmpty() ? shortcode : "@" + username,
                                Collections.unmodifiableList(videos));
                    }
                }
                Iterator<String> keys = object.keys();
                while (keys.hasNext()) enqueue(pending, object.opt(keys.next()));
            } else if (value instanceof JSONArray array) {
                for (int i = 0; i < array.length(); i++) enqueue(pending, array.opt(i));
            }
        }
        return null;
    }

    private static void enqueue(ArrayDeque<Object> pending, Object value) {
        if (value instanceof JSONObject || value instanceof JSONArray) pending.addLast(value);
    }

    private static boolean matchesPost(JSONObject object, String shortcode, String mediaId) {
        String pk = object.optString("pk");
        String id = object.optString("id");
        return mediaId.equals(pk) || mediaId.equals(id) || ("POLARIS_" + mediaId).equals(id) ||
                shortcode.equals(object.optString("code")) || shortcode.equals(object.optString("shortcode"));
    }

    private static List<Video> readVideos(JSONObject post) {
        List<Video> videos = new ArrayList<>();
        JSONArray carousel = post.optJSONArray("carousel_media");
        int count = carousel == null ? 1 : carousel.length();
        for (int i = 0; i < count; i++) {
            JSONObject item = carousel == null ? post : carousel.optJSONObject(i);
            URI url = bestVideo(item == null ? null : item.optJSONArray("video_versions"));
            if (url != null) videos.add(new Video(url, i + 1));
        }
        return videos;
    }

    private static URI bestVideo(JSONArray versions) {
        URI best = null;
        long bestArea = -1;
        if (versions == null) return null;
        for (int i = 0; i < versions.length(); i++) {
            JSONObject version = versions.optJSONObject(i);
            if (version == null) continue;
            URI url;
            try {
                url = URI.create(version.optString("url"));
            } catch (IllegalArgumentException ignored) {
                continue;
            }
            if (!isMediaUri(url)) continue;
            long area = (long) Math.max(0, version.optInt("width")) * Math.max(0, version.optInt("height"));
            if (area > bestArea) {
                best = url;
                bestArea = area;
            }
        }
        return best;
    }

    static boolean isMediaUri(URI uri) {
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null ||
                uri.getUserInfo() != null || uri.getPort() != -1) return false;
        host = host.toLowerCase(Locale.ROOT);
        return host.equals("cdninstagram.com") || host.endsWith(".cdninstagram.com") ||
                host.equals("fbcdn.net") || host.endsWith(".fbcdn.net");
    }
}
