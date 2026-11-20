package com.newbie7666.netpandownload.spidergateway;

/** Keep the actionable root failure rather than reporting InvocationTargetException. */
final class SpiderFailure {
    private SpiderFailure() {}

    static Throwable rootCause(Throwable throwable) {
        Throwable current = throwable;
        for (int i = 0; i < 24 && current != null; i++) {
            Throwable next = current.getCause();
            if (next == null || next == current) return current;
            current = next;
        }
        return current == null ? throwable : current;
    }

    static String describe(Throwable throwable) {
        Throwable root = rootCause(throwable);
        if (root == null) return "Unknown Spider failure";
        String message = root.getMessage();
        String kind = root.getClass().getSimpleName();
        if (message == null || message.trim().isEmpty()) return kind;
        return kind + ": " + message;
    }
}
