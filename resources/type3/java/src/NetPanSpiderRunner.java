import java.io.File;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Small desktop host for CatVod/TVBox JVM spiders.
 *
 * <p>Usage: NetPanSpiderRunner &lt;class&gt; &lt;action&gt; &lt;ext&gt; &lt;keyword&gt;
 * &lt;page&gt; &lt;id&gt; &lt;flag&gt; &lt;vip-flags-base64&gt;. The result is the only stdout
 * line; diagnostics and accidental Spider logging go to stderr.</p>
 *
 * <p>The host intentionally uses reflection for Android and Spider APIs. The
 * prepared runtime supplies Android API stubs on the parent class path, while
 * the downloaded Spider is loaded in a child URLClassLoader.</p>
 */
public final class NetPanSpiderRunner {
    private NetPanSpiderRunner() {
    }

    public static void main(String[] args) {
        final PrintStream resultOut = new PrintStream(System.out, true, java.nio.charset.StandardCharsets.UTF_8);
        System.setOut(System.err);
        int exitCode = 0;
        try {
            if (args.length < 2) {
                throw new IllegalArgumentException("usage: NetPanSpiderRunner <class> <action> [ext] [keyword] [page] [id] [flag]");
            }
            final String[] values = new String[8];
            for (int index = 0; index < values.length; index++) {
                values[index] = index < args.length ? decodeTransportArg(args[index]) : "";
            }
            String[] classPath = System.getProperty("java.class.path", "").split(java.util.regex.Pattern.quote(File.pathSeparator));
            URL[] urls = new URL[classPath.length];
            for (int index = 0; index < classPath.length; index++) {
                if (classPath[index].isEmpty()) throw new IllegalArgumentException("empty classpath entry");
                urls[index] = new File(classPath[index]).getCanonicalFile().toURI().toURL();
            }

            HostContext host = createHostContext();
            try (URLClassLoader loader = new URLClassLoader(urls, NetPanSpiderRunner.class.getClassLoader())) {
                initializeGlobalSpiderState(loader, host.context);
                Class<?> spiderClass = Class.forName(values[0], true, loader);
                Object spider = newSpider(spiderClass);
                initializeSpider(spiderClass, spider, host.context, values[2]);
                initializeSpiderApi(spiderClass, spider, loader);
                Object result = invokeAction(spiderClass, spider, values[1], values[3], values[4], values[5], values[6], values[7]);
                if (result == null || result.toString().trim().isEmpty()) {
                    throw new IllegalStateException("Spider returned empty output");
                }
                resultOut.println(result.toString().trim());
                resultOut.flush();
            }
        } catch (Throwable error) {
            Throwable cause = unwrap(error);
            System.err.println("[NetPanSpiderRunner] " + cause.getClass().getName() + ": " + String.valueOf(cause.getMessage()));
            cause.printStackTrace(System.err);
            exitCode = 1;
        } finally {
            System.setOut(resultOut);
        }
        System.exit(exitCode);
    }

    /** Decode the ASCII wire format before invoking Spider methods. */
    private static String decodeTransportArg(String value) {
        final String prefix = "netpan_utf8_base64:";
        if (!value.startsWith(prefix)) return value;
        byte[] bytes = java.util.Base64.getDecoder().decode(value.substring(prefix.length()));
        return new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static Throwable unwrap(Throwable error) {
        Throwable cause = error;
        while (cause instanceof InvocationTargetException && cause.getCause() != null) cause = cause.getCause();
        return cause;
    }

    private static final class HostContext {
        final Object context;
        HostContext(Object context) { this.context = context; }
    }

    private static HostContext createHostContext() throws Exception {
        ClassLoader parent = NetPanSpiderRunner.class.getClassLoader();
        Class<?> contextClass = Class.forName("android.content.Context", true, parent);
        String base = System.getProperty("tvbox.spiderCacheDir", "").trim();
        if (!base.isEmpty()) {
            try {
                contextClass.getMethod("setBaseDir", File.class).invoke(null, new File(base));
            } catch (NoSuchMethodException ignored) {
                // Older stub sets do not expose a configurable base directory.
            }
        }
        Class<?> applicationClass = Class.forName("android.app.Application", true, parent);
        Constructor<?> constructor = applicationClass.getDeclaredConstructor();
        constructor.setAccessible(true);
        Object application = constructor.newInstance();
        try {
            Class<?> activityThread = Class.forName("android.app.ActivityThread", true, parent);
            activityThread.getMethod("setCurrentApplication", applicationClass).invoke(null, application);
        } catch (ClassNotFoundException | NoSuchMethodException ignored) {
            // ActivityThread is optional for ordinary JVM spiders.
        }
        return new HostContext(application);
    }

    private static void initializeGlobalSpiderState(URLClassLoader loader, Object context) throws Exception {
        initializeContextClass(loader, "com.github.catvod.spider.Init", context);
        initializeContextClass(loader, "com.github.catvod.spider.InitOrigin", context);
    }

    private static void initializeContextClass(URLClassLoader loader, String className, Object context) throws Exception {
        final Class<?> stateClass;
        try {
            stateClass = Class.forName(className, true, loader);
        } catch (ClassNotFoundException ignored) {
            return;
        }
        Class<?> contextClass = Class.forName("android.content.Context", true, loader);
        try {
            stateClass.getMethod("init", contextClass).invoke(null, context);
        } catch (NoSuchMethodException ignored) {
            // A version without this global hook is supported.
        }
    }

    private static Object newSpider(Class<?> spiderClass) throws Exception {
        Constructor<?> constructor = spiderClass.getDeclaredConstructor();
        constructor.setAccessible(true);
        return constructor.newInstance();
    }

    private static void initializeSpider(Class<?> spiderClass, Object spider, Object context, String ext) throws Exception {
        Class<?> contextClass = Class.forName("android.content.Context", true, spiderClass.getClassLoader());
        try {
            spiderClass.getMethod("init", contextClass, String.class).invoke(spider, context, ext);
            return;
        } catch (NoSuchMethodException ignored) {
            // Try older overloads.
        }
        try {
            spiderClass.getMethod("init", contextClass).invoke(spider, context);
            return;
        } catch (NoSuchMethodException ignored) {
            // Try ordinary JVM overloads.
        }
        try {
            spiderClass.getMethod("init", String.class).invoke(spider, ext);
            return;
        } catch (NoSuchMethodException ignored) {
            // Try a no-argument hook below.
        }
        try {
            spiderClass.getMethod("init").invoke(spider);
        } catch (NoSuchMethodException ignored) {
            // A no-init Spider is valid for the desktop contract.
        }
    }

    private static void initializeSpiderApi(Class<?> spiderClass, Object spider, ClassLoader loader) throws Exception {
        final Class<?> apiClass;
        try {
            apiClass = Class.forName("com.github.catvod.crawler.SpiderApi", true, loader);
        } catch (ClassNotFoundException ignored) {
            return;
        }
        final Method initApi;
        try {
            initApi = spiderClass.getMethod("initApi", apiClass);
        } catch (NoSuchMethodException ignored) {
            return;
        }
        final Constructor<?> constructor;
        try {
            constructor = apiClass.getDeclaredConstructor();
        } catch (NoSuchMethodException ignored) {
            return;
        }
        constructor.setAccessible(true);
        initApi.invoke(spider, constructor.newInstance());
    }

    private static Object invokeAction(Class<?> spiderClass, Object spider, String action,
                                       String keyword, String page, String id, String flag, String encodedVipFlags) throws Exception {
        if ("home".equals(action)) {
            return spiderClass.getMethod("homeContent", boolean.class).invoke(spider, true);
        }
        if ("search".equals(action)) {
            try {
                return spiderClass.getMethod("searchContent", String.class, boolean.class, String.class)
                        .invoke(spider, keyword, false, page.isEmpty() ? "1" : page);
            } catch (NoSuchMethodException ignored) {
                return spiderClass.getMethod("searchContent", String.class, boolean.class).invoke(spider, keyword, false);
            }
        }
        if ("detail".equals(action)) {
            List<String> ids = new ArrayList<String>();
            if (!id.isEmpty()) ids.addAll(Arrays.asList(id.split(",", -1)));
            return spiderClass.getMethod("detailContent", List.class).invoke(spider, ids);
        }
        if ("play".equals(action)) {
            return spiderClass.getMethod("playerContent", String.class, String.class, List.class)
                    .invoke(spider, flag, id, decodeVipFlags(encodedVipFlags));
        }
        throw new IllegalArgumentException("unknown action: " + action);
    }

    private static List<String> decodeVipFlags(String encoded) {
        List<String> result = new ArrayList<String>();
        if (encoded == null || encoded.isEmpty()) return result;
        try {
            String decoded = new String(java.util.Base64.getDecoder().decode(encoded), java.nio.charset.StandardCharsets.UTF_8);
            for (String value : decoded.split("\\u001f", -1)) {
                if (!value.isEmpty()) result.add(value);
            }
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("invalid vip flag encoding", error);
        }
        return result;
    }
}
