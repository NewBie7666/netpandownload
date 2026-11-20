package com.github.catvod.crawler;

import android.content.Context;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal clean-room CatVod SPI signatures for plugins built against TVBox.
 * This is NOT a drop-in implementation of every FongMi/CatVod runtime class.
 * Unavailable host APIs fail explicitly rather than faking Spider output.
 */
public class Spider {
    public void init(Context context, String extend) {}
    public void init(Context context) {}
    public String homeContent(boolean filter) { return "{}"; }
    public String homeVideoContent() { return "{}"; }
    public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) { return "{}"; }
    public String detailContent(List<String> ids) { return "{}"; }
    public String searchContent(String key, boolean quick) { return "{}"; }
    public String searchContent(String key, boolean quick, String page) { return searchContent(key, quick); }
    public String playerContent(String flag, String id, List<String> vipFlags) { return "{}"; }
    public String action(String action) { return "{}"; }
    public Object[] proxyLocal(Map<String, String> params) { return null; }
}
