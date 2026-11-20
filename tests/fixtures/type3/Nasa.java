package com.github.catvod.spider;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;

/** Own NASA live QA Spider; it is not a community TVBox source. */
public final class Nasa {
    private final Gson gson = new Gson();
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build();

    public Nasa() {
    }

    public void init(String ext) {
    }

    private JsonObject get(String url) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .header("User-Agent", "NetPanDownload-Type3-QA")
                .timeout(Duration.ofSeconds(45)).GET().build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("NASA HTTP " + response.statusCode());
        }
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }

    private JsonObject dataItem(JsonObject item) {
        JsonArray data = item.getAsJsonArray("data");
        return data == null || data.size() == 0 ? new JsonObject() : data.get(0).getAsJsonObject();
    }

    private JsonObject video(JsonObject item) {
        JsonObject data = dataItem(item);
        JsonObject vod = new JsonObject();
        vod.addProperty("vod_id", data.has("nasa_id") ? data.get("nasa_id").getAsString() : "");
        vod.addProperty("vod_name", data.has("title") ? data.get("title").getAsString() : "NASA video");
        vod.addProperty("vod_content", data.has("description") ? data.get("description").getAsString() : "");
        return vod;
    }

    private JsonArray find(String query) throws Exception {
        String url = "https://images-api.nasa.gov/search?media_type=video&page_size=10&" + query;
        JsonObject root = get(url);
        JsonObject collection = root.getAsJsonObject("collection");
        return collection == null || !collection.has("items") ? new JsonArray() : collection.getAsJsonArray("items");
    }

    private String idOf(JsonObject item) {
        JsonObject data = dataItem(item);
        return data.has("nasa_id") ? data.get("nasa_id").getAsString() : "";
    }

    private String encodePath(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private boolean hasPreview(String id) {
        try {
            JsonObject root = get("https://images-api.nasa.gov/asset/" + encodePath(id));
            JsonArray items = root.getAsJsonObject("collection").getAsJsonArray("items");
            for (JsonElement element : items) {
                JsonObject item = element.getAsJsonObject();
                if (item.has("href") && item.get("href").getAsString().matches(".*~preview\\.mp4$")) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    public String homeContent(boolean filter) {
        JsonObject root = new JsonObject();
        root.add("class", new JsonArray());
        root.add("list", new JsonArray());
        return gson.toJson(root);
    }

    public String searchContent(String key, boolean quick, String page) throws Exception {
        JsonArray list = new JsonArray();
        JsonArray items = find("q=" + URLEncoder.encode(key, StandardCharsets.UTF_8));
        for (JsonElement item : items) {
            JsonObject row = item.getAsJsonObject();
            if (list.size() == 0 && hasPreview(idOf(row))) list.add(video(row));
        }
        JsonObject root = new JsonObject();
        root.add("list", list);
        root.addProperty("page", page);
        root.addProperty("pagecount", 1);
        return gson.toJson(root);
    }

    public String detailContent(List<String> ids) throws Exception {
        String id = ids.isEmpty() ? "" : ids.get(0);
        JsonArray items = find("nasa_id=" + URLEncoder.encode(id, StandardCharsets.UTF_8));
        JsonArray list = new JsonArray();
        if (items.size() > 0) {
            JsonObject vod = video(items.get(0).getAsJsonObject());
            vod.addProperty("vod_play_from", "NASA");
            vod.addProperty("vod_play_url", "Preview$" + id);
            list.add(vod);
        }
        JsonObject root = new JsonObject();
        root.add("list", list);
        return gson.toJson(root);
    }

    public String playerContent(String flag, String id, List<String> vipFlags) throws Exception {
        JsonObject root = get("https://images-api.nasa.gov/asset/" + encodePath(id));
        JsonArray items = root.getAsJsonObject("collection").getAsJsonArray("items");
        String media = "";
        for (JsonElement element : items) {
            JsonObject item = element.getAsJsonObject();
            if (!item.has("href")) continue;
            String href = item.get("href").getAsString();
            if (href.matches(".*~preview\\.mp4$")) {
                media = href.replaceFirst("^http:", "https:");
                break;
            }
        }
        if (media.isEmpty()) throw new IllegalStateException("NASA asset has no preview MP4");
        JsonObject result = new JsonObject();
        result.addProperty("parse", 0);
        result.addProperty("url", media);
        return gson.toJson(result);
    }
}
