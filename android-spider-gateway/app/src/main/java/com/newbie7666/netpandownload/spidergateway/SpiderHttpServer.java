package com.newbie7666.netpandownload.spidergateway;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class SpiderHttpServer {
    private static final String TAG = "NetPanSpiderGateway";
    private static final String PREFS = "spider-gateway";
    private static final String TOKEN_KEY = "token";
    private static final int MAX_HEADER_LINE = 8192;
    private final Context context;
    private final SpiderRuntime runtime;
    private final ExecutorService clients = Executors.newFixedThreadPool(4);
    private final ExecutorService spiderWorker = Executors.newSingleThreadExecutor();
    private volatile ServerSocket socket;
    private volatile Thread acceptThread;

    SpiderHttpServer(Context context) {
        this.context = context.getApplicationContext();
        runtime = new SpiderRuntime(this.context);
        token(this.context);
    }

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String token(Context context) {
        SharedPreferences prefs = preferences(context);
        String value = prefs.getString(TOKEN_KEY, "");
        if (value != null && value.matches("[a-f0-9]{48}")) return value;
        return rotateToken(context);
    }

    static String rotateToken(Context context) {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder value = new StringBuilder(48);
        for (byte b : bytes) value.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        preferences(context).edit().putString(TOKEN_KEY, value.toString()).apply();
        return value.toString();
    }

    synchronized void start(boolean allowLan) throws IOException {
        if (socket != null && !socket.isClosed()) return;
        ServerSocket server = new ServerSocket();
        InetAddress bind = InetAddress.getByName(allowLan ? "0.0.0.0" : "127.0.0.1");
        server.bind(new InetSocketAddress(bind, GatewayContract.PORT), 16);
        socket = server;
        Thread thread = new Thread(this::acceptLoop, "spider-gateway-accept");
        thread.setDaemon(true);
        acceptThread = thread;
        thread.start();
    }

    synchronized void stop() {
        ServerSocket old = socket;
        socket = null;
        if (old != null) try { old.close(); } catch (IOException ignored) {}
        if (acceptThread != null) acceptThread.interrupt();
        clients.shutdownNow();
        spiderWorker.shutdownNow();
    }

    private void acceptLoop() {
        while (socket != null && !socket.isClosed()) {
            try {
                Socket client = socket.accept();
                client.setSoTimeout(90000);
                clients.execute(() -> handle(client));
            } catch (IOException e) {
                if (socket != null && !socket.isClosed()) Log.e(TAG, "Accept failed", e);
            }
        }
    }

    private void handle(Socket client) {
        try (Socket connection = client;
             InputStream in = new BufferedInputStream(connection.getInputStream());
             BufferedOutputStream out = new BufferedOutputStream(connection.getOutputStream())) {
            String first = readLine(in);
            if (first == null) return;
            String[] request = first.split(" ", 3);
            if (request.length < 3) { respond(out, 400, failure("Invalid HTTP request")); return; }
            String method = request[0], path = request[1];
            int length = -1;
            String authorization = "";
            int headerBytes = 0;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                headerBytes += line.length();
                if (headerBytes > 32000) { respond(out, 413, failure("Headers too large")); return; }
                int separator = line.indexOf(':');
                if (separator < 0) continue;
                String name = line.substring(0, separator).trim().toLowerCase(Locale.ROOT);
                String value = line.substring(separator + 1).trim();
                if (name.equals("authorization")) authorization = value;
                if (name.equals("content-length")) {
                    try { length = Integer.parseInt(value); }
                    catch (NumberFormatException e) { respond(out, 400, failure("Invalid Content-Length")); return; }
                }
                if (name.equals("transfer-encoding")) { respond(out, 400, failure("Chunked body unsupported")); return; }
            }
            if (method.equals("GET") && path.equals("/v1/spider/health")) {
                JSONObject health = new JSONObject();
                health.put("ok", true);
                health.put("runtime", "netpan-android");
                health.put("port", GatewayContract.PORT);
                health.put("api", 1);
                respond(out, 200, health.toString());
                return;
            }
            if (!method.equals("POST") || !path.startsWith("/v1/spider/")) {
                respond(out, 404, failure("Unsupported endpoint")); return;
            }
            String expected = "Bearer " + token(context);
            if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                    authorization.getBytes(StandardCharsets.UTF_8))) {
                respond(out, 401, failure("Invalid Gateway token")); return;
            }
            if (length < 2 || length > GatewayContract.MAX_REQUEST_BYTES) {
                respond(out, 413, failure("Missing or excessive Content-Length")); return;
            }
            byte[] body = new byte[length];
            int offset = 0;
            while (offset < length) {
                int count = in.read(body, offset, length - offset);
                if (count < 0) break;
                offset += count;
            }
            if (offset != length) { respond(out, 400, failure("Incomplete JSON body")); return; }
            JSONObject payload;
            try { payload = new JSONObject(new String(body, StandardCharsets.UTF_8)); }
            catch (Exception error) { respond(out, 400, failure("JSON object required")); return; }
            String action = path.substring("/v1/spider/".length());
            if (!action.matches("home|search|detail|player")) {
                respond(out, 422, failure("Unsupported Spider action")); return;
            }
            try {
                Future<JSONObject> future = spiderWorker.submit(() -> runtime.call(action, payload));
                JSONObject result;
                try { result = future.get(75, TimeUnit.SECONDS); }
                catch (TimeoutException e) {
                    future.cancel(true);
                    throw new IllegalStateException("Android Spider timed out");
                }
                respond(out, 200, result.toString());
            } catch (Throwable error) {
                Throwable cause = SpiderFailure.rootCause(error);
                String message = SpiderFailure.describe(error).replace(token(context), "[redacted]");
                Log.e(TAG, "Spider execution failed", error);
                respond(out, 502, failure(message.substring(0, Math.min(450, message.length()))));
            }
        } catch (IOException e) {
            Log.w(TAG, "Gateway client disconnected: " + e.getClass().getSimpleName());
        } catch (Exception e) {
            Log.e(TAG, "Gateway request failed", e);
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        while (buffer.size() <= MAX_HEADER_LINE) {
            int next = in.read();
            if (next < 0) return buffer.size() == 0 ? null : buffer.toString("UTF-8");
            if (next == '\n') return buffer.toString("UTF-8");
            if (next != '\r') buffer.write(next);
        }
        throw new IOException("HTTP header line too large");
    }

    private static String failure(String message) {
        try { return new JSONObject().put("ok", false).put("message", message).toString(); }
        catch (Exception e) { return "{\"ok\":false,\"message\":\"Spider failure\"}"; }
    }

    private static void respond(BufferedOutputStream out, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > GatewayContract.MAX_RESPONSE_BYTES) {
            status = 502;
            bytes = failure("Spider response exceeds 2MB").getBytes(StandardCharsets.UTF_8);
        }
        String header = "HTTP/1.1 " + status + " " + (status == 200 ? "OK" : "Error") + "\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: " + bytes.length + "\r\n" +
                "Cache-Control: no-store\r\n" +
                "X-Content-Type-Options: nosniff\r\n" +
                "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }
}
