package com.newbie7666.netpandownload.spidergateway;

import android.content.Context;
import android.os.Build;
import dalvik.system.DexClassLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Android's real DexClassLoader + native-library search path, not a JVM DEX
 * converter. The host deliberately implements only an audited minimum CatVod
 * SPI. Some protected Spiders require additional FongMi/CatVod host classes.
 * Such plugins MUST fail visibly, not be claimed to work.
 *
 * Third-party Spider code executes within this app's Android process. Only
 * import trustworthy sources; this is not a secure untrusted-code sandbox.
 */
final class SpiderRuntime {
    private static final int MAX_JAR_BYTES = 20 * 1024 * 1024;
    private static final int MAX_NATIVE_BYTES = 12 * 1024 * 1024;
    private final Context context;
    private final LinkedHashMap<String, Loaded> cache = new LinkedHashMap<String, Loaded>(8, .75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Loaded> entry) { return size() > 4; }
    };

    private static final class Loaded {
        final Object instance;
        final Class<?> spiderClass;
        Loaded(Object instance, Class<?> spiderClass) {
            this.instance = instance;
            this.spiderClass = spiderClass;
        }
    }

    SpiderRuntime(Context context) { this.context = context.getApplicationContext(); }

    synchronized JSONObject call(String action, JSONObject payload) throws Exception {
        JSONObject site = payload.optJSONObject("site");
        if (site == null) throw new IllegalArgumentException("Missing site");
        String api = site.optString("api", "");
        String className = GatewayContract.spiderClassName(api);
        String jar = site.optString("jar", "");
        String ext = site.optString("ext", "");
        if (ext.length() > 16384) throw new IllegalArgumentException("Extension too large");
        Loaded loaded = load(jar, ext, className);
        Object result;
        switch (action) {
            case "home":
                result = invoke(loaded, "homeContent", new Class<?>[]{boolean.class}, new Object[]{true});
                break;
            case "search": {
                String keyword = payload.optString("keyword", "");
                String page = payload.optString("page", "1");
                if (keyword.length() > 240 || page.length() > 8)
                    throw new IllegalArgumentException("Search arguments too long");
                try {
                    result = invoke(loaded, "searchContent",
                            new Class<?>[]{String.class, boolean.class, String.class},
                            new Object[]{keyword, false, page});
                } catch (NoSuchMethodException error) {
                    if (!"1".equals(page)) throw new UnsupportedOperationException("Spider lacks paginated search");
                    result = invoke(loaded, "searchContent",
                            new Class<?>[]{String.class, boolean.class},
                            new Object[]{keyword, false});
                }
                break;
            }
            case "detail": {
                String id = payload.optString("id", "");
                if (id.length() > 4096) throw new IllegalArgumentException("Detail ID too long");
                result = invoke(loaded, "detailContent", new Class<?>[]{List.class},
                        new Object[]{Arrays.asList(id)});
                break;
            }
            case "player": {
                String id = payload.optString("id", "");
                String flag = payload.optString("flag", "");
                if (id.length() > 4096 || flag.length() > 512)
                    throw new IllegalArgumentException("Play arguments too long");
                result = invoke(loaded, "playerContent",
                        new Class<?>[]{String.class, String.class, List.class},
                        new Object[]{flag, id, new ArrayList<String>()});
                break;
            }
            default: throw new IllegalArgumentException("Unsupported Spider method");
        }
        if (result == null) throw new IllegalStateException("Spider returned null");
        JSONObject response;
        try { response = result instanceof JSONObject ? (JSONObject) result : new JSONObject(result.toString()); }
        catch (Exception error) { throw new IllegalStateException("Spider returned invalid JSON object", error); }
        if (response.optInt("code", 0) < 0)
            throw new IllegalStateException(response.optString("msg", "Spider returned failure code"));
        if (action.equals("search") || action.equals("detail")) {
            if (!(response.opt("list") instanceof JSONArray))
                throw new IllegalStateException("Spider " + action + " did not return a list");
        }
        if (action.equals("player") && response.optString("url", "").isEmpty())
            throw new IllegalStateException("Spider player did not return a media URL");
        return response;
    }

    private static Object invoke(Loaded loaded, String name, Class<?>[] types, Object[] args) throws Exception {
        Method method = loaded.spiderClass.getMethod(name, types);
        try { return method.invoke(loaded.instance, args); }
        catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw error;
        }
    }

    private Loaded load(String rawJar, String ext, String className) throws Exception {
        boolean allowHttp = SpiderHttpServer.preferences(context).getBoolean("allow_http_spider_jars", false);
        GatewayContract.JarSpec spec = GatewayContract.parseJar(rawJar, allowHttp);
        String key = digest("SHA-256", (spec.uri.toString() + "|" + spec.md5 + "|" + className + "|" + ext)
                .getBytes(StandardCharsets.UTF_8));
        Loaded cached = cache.get(key);
        if (cached != null) return cached;
        File privateRoot = new File(context.getFilesDir(), "spider-runtime");
        if (!privateRoot.exists() && !privateRoot.mkdirs())
            throw new IllegalStateException("Cannot create Spider cache");
        String artifactKey = digest("SHA-256", (spec.uri.toString() + "|" + spec.md5)
                .getBytes(StandardCharsets.UTF_8));
        File jar = new File(privateRoot, artifactKey + ".jar");
        if (!jar.isFile()) {
            byte[] contents = readJar(spec.uri, MAX_JAR_BYTES, allowHttp);
            if (!spec.md5.isEmpty() && !digest("MD5", contents).equals(spec.md5))
                throw new SecurityException("Spider jar MD5 mismatch");
            // Download into an owned directory and rename a read-only file for
            // Android 14+ dynamic-code-loading policy.
            File temp = new File(privateRoot, artifactKey + ".part");
            try (FileOutputStream stream = new FileOutputStream(temp)) { stream.write(contents); }
            if (!temp.setReadOnly()) throw new IllegalStateException("Cannot mark DEX file read-only");
            if (!temp.renameTo(jar)) throw new IllegalStateException("Cannot finalize downloaded Spider jar");
        } else if (!spec.md5.isEmpty()) {
            if (!digestFile("MD5", jar).equals(spec.md5))
                throw new SecurityException("Cached Spider jar MD5 mismatch");
        }
        File nativeDirectory = new File(privateRoot, artifactKey + "-native");
        if (!nativeDirectory.exists() && !nativeDirectory.mkdirs())
            throw new IllegalStateException("Cannot create native cache");
        extractNativeLibraries(jar, nativeDirectory);
        DexClassLoader loader = new DexClassLoader(jar.getAbsolutePath(),
                context.getCodeCacheDir().getAbsolutePath(), nativeDirectory.getAbsolutePath(),
                getClass().getClassLoader());
        // TVBox/CatVod initializes the JAR's *static* Init.init(Context)
        // BEFORE creating any csp_* spider. Guard constructors can call
        // DexNative.<clinit>/getSpider, which needs the application Context
        // already stored by that entry point. Spider.init(Context, ext) comes
        // later and cannot fix a constructor-time null Context.
        initializeJarHost(loader);
        Class<?> cls = loader.loadClass(className);
        Object spider;
        try { spider = cls.getDeclaredConstructor().newInstance(); }
        catch (InvocationTargetException error) { throw propagateInvocation(error); }
        try {
            Method init = cls.getMethod("init", Context.class, String.class);
            init.invoke(spider, context, ext);
        } catch (NoSuchMethodException ignored) {
            try { cls.getMethod("init", Context.class).invoke(spider, context); }
            catch (NoSuchMethodException ignoredAgain) { /* self-contained Spider */ }
        } catch (InvocationTargetException error) {
            throw propagateInvocation(error);
        }
        Loaded loaded = new Loaded(spider, cls);
        cache.put(key, loaded);
        return loaded;
    }

    private void initializeJarHost(DexClassLoader loader) throws Exception {
        Class<?> initClass;
        try {
            initClass = loader.loadClass("com.github.catvod.spider.Init");
        } catch (ClassNotFoundException ignored) {
            // Older self-contained CatVod spiders may not ship an Init class.
            // In that case their instance init(Context, ext) is still invoked.
            return;
        }
        Method method;
        try { method = initClass.getMethod("init", Context.class); }
        catch (NoSuchMethodException ignored) {
            // Not all Type3 JARs expose the classic TVBox host-init entry.
            return;
        }
        if (!java.lang.reflect.Modifier.isStatic(method.getModifiers())) {
            throw new IllegalStateException("Spider JAR Init.init(Context) must be static");
        }
        try {
            method.invoke(null, context);
        } catch (InvocationTargetException error) {
            throw propagateInvocation(error);
        }
    }

    private static Exception propagateInvocation(InvocationTargetException error) throws Exception {
        Throwable cause = SpiderFailure.rootCause(error);
        if (cause instanceof Error) throw (Error) cause;
        if (cause instanceof Exception) return (Exception) cause;
        return new IllegalStateException("Spider invocation failed", cause);
    }

    private static byte[] readJar(URI address, int maxBytes, boolean allowHttp) throws Exception {
        URL target = address.toURL();
        for (int redirect = 0; redirect <= 3; redirect++) {
            GatewayContract.JarSpec checked = GatewayContract.parseJar(target.toString(), allowHttp);
            // This is defense in depth for Spider JAR download, not a sandbox for
            // any networking performed later by third-party Spider code.
            assertPublicJarHost(checked.uri.getHost());
            HttpURLConnection conn = (HttpURLConnection) target.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("User-Agent", "NetPanSpiderGateway/0.1");
            try {
                int status = conn.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = conn.getHeaderField("Location");
                    if (location == null || redirect == 3) throw new IllegalStateException("Too many Spider redirects");
                    URL nextUrl = new URL(target, location);
                    GatewayContract.JarSpec nextJar = GatewayContract.parseJar(nextUrl.toString(), allowHttp);
                    if ("https".equalsIgnoreCase(target.getProtocol()) &&
                        "http".equalsIgnoreCase(nextJar.uri.getScheme())) {
                        throw new SecurityException("HTTPS Spider JAR cannot redirect to HTTP");
                    }
                    target = nextUrl;
                    continue;
                }
                if (status != 200) throw new IllegalStateException("Spider jar HTTP status " + status);
                if (conn.getContentLengthLong() > maxBytes) throw new IllegalStateException("Spider jar exceeds size limit");
                try (InputStream input = conn.getInputStream()) { return readLimited(input, maxBytes); }
            } finally { conn.disconnect(); }
        }
        throw new IllegalStateException("Spider jar redirect failure");
    }

    private static void assertPublicJarHost(String host) throws Exception {
        for (InetAddress address : InetAddress.getAllByName(host)) {
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() ||
                address.isLinkLocalAddress() || address.isSiteLocalAddress() ||
                address.isMulticastAddress()) {
                throw new SecurityException("Spider JAR host resolves to a local or private address");
            }
        }
    }

    private static byte[] readLimited(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] bytes = new byte[8192];
        int count;
        while ((count = input.read(bytes)) != -1) {
            if (out.size() + count > limit) throw new IllegalStateException("Spider artifact exceeds size limit");
            out.write(bytes, 0, count);
        }
        return out.toByteArray();
    }

    private static void extractNativeLibraries(File jar, File directory) throws Exception {
        boolean foundDex = false;
        long totalNative = 0;
        boolean arm64 = false;
        for (String abi : Build.SUPPORTED_ABIS) if (abi.equals("arm64-v8a")) arm64 = true;
        try (ZipInputStream zip = new ZipInputStream(new FileInputStream(jar))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String path = entry.getName();
                if (path.equals("classes.dex")) foundDex = true;
                if (!entry.isDirectory() && path.endsWith(".so") &&
                    (path.startsWith("assets/") || path.startsWith("lib/"))) {
                    String lower = path.toLowerCase(java.util.Locale.ROOT);
                    boolean isV8 = lower.contains("arm64") || lower.contains("_v8.so");
                    boolean isV7 = lower.contains("armeabi") || lower.contains("_v7.so");
                    if ((arm64 && isV7) || (!arm64 && isV8)) { zip.closeEntry(); continue; }
                    if (lower.startsWith("lib/") && !lower.contains(arm64 ? "arm64-v8a" : "armeabi-v7a")) {
                        zip.closeEntry(); continue;
                    }
                    String name = path.substring(path.lastIndexOf('/') + 1);
                    if (!name.matches("[A-Za-z0-9_.-]{3,140}") || name.startsWith(".")) {
                        zip.closeEntry(); continue;
                    }
                    byte[] data = readLimited(zip, MAX_NATIVE_BYTES);
                    totalNative += data.length;
                    if (totalNative > 32L * 1024 * 1024) throw new IllegalStateException("Native libraries too large");
                    if (data.length < 6 || data[0] != 0x7f || data[1] != 'E' || data[2] != 'L' || data[3] != 'F') {
                        throw new IllegalStateException("Native library is not an ELF image");
                    }
                    int elfClass = data[4] & 0xff;
                    if (elfClass != (arm64 ? 2 : 1)) {
                        throw new IllegalStateException("Native library ABI mismatch: " + name);
                    }
                    writeNative(directory, name, data);
                    if (!name.startsWith("lib")) writeNative(directory, "lib" + name, data);
                }
                zip.closeEntry();
            }
        }
        if (!foundDex) throw new IllegalStateException("Spider jar is missing classes.dex (class-only JAR unsupported)");
    }

    private static void writeNative(File dir, String name, byte[] data) throws Exception {
        File file = new File(dir, name);
        if (file.isFile() && file.length() == data.length) return;
        try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(data); }
        if (!file.setReadOnly()) throw new IllegalStateException("Cannot mark native library read-only");
    }

    private static String digestFile(String algorithm, File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) { return digest(algorithm, readLimited(in, MAX_JAR_BYTES)); }
    }

    private static String digest(String algorithm, byte[] content) throws Exception {
        byte[] result = MessageDigest.getInstance(algorithm).digest(content);
        StringBuilder out = new StringBuilder(result.length * 2);
        for (byte item : result) out.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return out.toString();
    }
}
