package com.newbie7666.netpandownload.mobile;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** The anonymous request path for public Instagram posts and their MP4 media. */
final class InstagramProvider {
    private static final String ORIGIN = "https://www.instagram.com/";
    private static final String CRAWLER = "Googlebot/2.1 (+http://www.google.com/bot.html)";
    private static final String MOBILE = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    private static final long MAX_PAGE_BYTES = 8L * 1024 * 1024;
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .followRedirects(false)
            .build();
    private final BooleanSupplier cancelled;
    private volatile Call activeCall;

    InstagramProvider(BooleanSupplier cancelled) {
        this.cancelled = cancelled;
    }

    InstagramPage.Post inspect(String postUrl) throws IOException {
        // The caller has already validated the Instagram post URL via UrlTools.
        String[] path = URI.create(postUrl).getPath().split("/");
        String shortcode = path[2];
        Request request = new Request.Builder()
                .url(ORIGIN + path[1].toLowerCase(Locale.ROOT) + "/" + shortcode + "/")
                .header("User-Agent", CRAWLER)
                .build();
        return execute(request, 20, response -> {
            if (response.isRedirect() && response.header("Location", "").contains("/accounts/login")) {
                throw new IOException("Instagram public page: login required");
            }
            ResponseBody body = requireBody(response, "Instagram public page");
            if (body.source().request(MAX_PAGE_BYTES + 1)) {
                throw new IOException("Instagram public page exceeds size limit");
            }
            checkCancelled();
            InstagramPage.Post post = InstagramPage.parse(body.string(), shortcode);
            if (post == null) throw new IOException("Instagram public page: no video file for this post");
            return post;
        });
    }

    List<File> download(InstagramPage.Post post, File directory, IntConsumer progress) throws IOException {
        List<File> files = new ArrayList<>();
        int count = post.videos().size();
        for (InstagramPage.Video video : post.videos()) {
            int completed = files.size();
            File target = new File(directory, "Instagram-" + post.shortcode() + "-" + video.position() + ".mp4");
            downloadVideo(video.url(), target, percent -> progress.accept((completed * 100 + percent) / count));
            files.add(target);
            progress.accept(files.size() * 100 / count);
        }
        return files;
    }

    private void downloadVideo(URI url, File target, IntConsumer progress) throws IOException {
        Request request = new Request.Builder()
                .url(url.toString())
                .header("User-Agent", MOBILE)
                .header("Referer", ORIGIN)
                .build();
        execute(request, 0, response -> {
            ResponseBody body = requireBody(response, "Instagram media");
            long length = body.contentLength();
            byte[] header = body.source().readByteArray(8);
            if (header[4] != 'f' || header[5] != 't' || header[6] != 'y' || header[7] != 'p') {
                throw new IOException("Instagram media: response is not an MP4");
            }
            try (InputStream in = body.byteStream(); FileOutputStream out = new FileOutputStream(target)) {
                out.write(header);
                long written = header.length;
                int previousPercent = -1;
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    checkCancelled();
                    out.write(buffer, 0, read);
                    written += read;
                    if (length > 0) {
                        int percent = (int) Math.min(100, written * 100 / length);
                        if (percent != previousPercent) progress.accept(percent);
                        previousPercent = percent;
                    }
                }
                if (written <= header.length || (length >= 0 && written != length)) {
                    throw new IOException("Instagram media: incomplete MP4");
                }
            }
            return null;
        });
    }

    void cancel() {
        Call call = activeCall;
        if (call != null) call.cancel();
    }

    private void checkCancelled() throws InterruptedIOException {
        if (cancelled.getAsBoolean()) throw new InterruptedIOException("用户取消任务");
    }

    private <T> T execute(Request request, int timeoutSeconds, ReadResponse<T> reader) throws IOException {
        Call call = client.newCall(request);
        if (timeoutSeconds > 0) call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS);
        activeCall = call;
        try {
            checkCancelled();
            try (Response response = call.execute()) {
                return reader.read(response);
            }
        } finally {
            activeCall = null;
        }
    }

    private static ResponseBody requireBody(Response response, String source) throws IOException {
        if (response.code() != 200) throw new IOException(source + ": HTTP error " + response.code());
        ResponseBody body = response.body();
        if (body == null) throw new IOException(source + ": empty media response");
        return body;
    }

    private interface ReadResponse<T> {
        T read(Response response) throws IOException;
    }
}
