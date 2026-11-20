package com.newbie7666.netpandownload.spidergateway;

import java.lang.reflect.InvocationTargetException;
import java.util.concurrent.ExecutionException;

import org.junit.Test;
import static org.junit.Assert.*;

public class SpiderFailureTest {
    @Test public void showsConstructorTimeContextNullRatherThanReflectionWrapper() {
        NullPointerException missingContext = new NullPointerException(
                "Cannot invoke Context.getCacheDir() because Context is null");
        InvocationTargetException reflection = new InvocationTargetException(
                new ExceptionInInitializerError(missingContext));
        ExecutionException async = new ExecutionException(reflection);
        assertSame(missingContext, SpiderFailure.rootCause(async));
        assertEquals("NullPointerException: Cannot invoke Context.getCacheDir() because Context is null",
                SpiderFailure.describe(async));
    }

    @Test public void displaysFailuresWithoutMessages() {
        assertEquals("IllegalStateException", SpiderFailure.describe(new IllegalStateException()));
    }
}
