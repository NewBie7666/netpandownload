package com.newbie7666.netpandownload.spidergateway;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;

/** Small standalone Android TV / phone console. No player or yt-dlp. */
public final class GatewayActivity extends Activity {
    private TextView status, address, token;
    private CheckBox allowLan;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding, padding, padding);
        scroll.addView(content);
        addText(content, "NetPan Spider Gateway", 26, Color.rgb(28, 44, 65));
        addText(content, "Android 7+ · 独立解析服务 · 端口 " + GatewayContract.PORT,
                14, Color.DKGRAY);
        addText(content, "仅处理 TVBox csp_* Spider 搜索、详情与播放地址；不含影视源、不下载视频，也不执行转码。",
                14, Color.DKGRAY);
        status = addText(content, "", 17, Color.rgb(30, 84, 63));
        address = addText(content, "", 14, Color.DKGRAY);
        token = addText(content, "", 13, Color.rgb(34, 47, 68));
        token.setTextIsSelectable(true);

        Button start = new Button(this);
        start.setText("启动 Spider Gateway");
        start.setOnClickListener(view -> {
            if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 51);
            }
            Intent intent = new Intent(this, GatewayService.class);
            intent.setAction(GatewayService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
            else startService(intent);
            refreshSoon();
        });
        content.addView(start);

        Button stop = new Button(this);
        stop.setText("停止 Gateway");
        stop.setOnClickListener(view -> {
            stopService(new Intent(this, GatewayService.class));
            refreshSoon();
        });
        content.addView(stop);

        Button copy = new Button(this);
        copy.setText("复制访问令牌（Token）");
        copy.setOnClickListener(view -> {
            String value = SpiderHttpServer.token(this);
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("Spider Gateway token", value));
            Toast.makeText(this, "令牌已复制，请妥善保管", Toast.LENGTH_SHORT).show();
        });
        content.addView(copy);

        Button rotate = new Button(this);
        rotate.setText("生成新令牌（旧令牌立即失效）");
        rotate.setOnClickListener(view -> {
            SpiderHttpServer.rotateToken(this);
            refresh();
        });
        content.addView(rotate);

        allowLan = new CheckBox(this);
        allowLan.setText("允许局域网连接（HTTP 明文；仅可信网络）");
        allowLan.setChecked(SpiderHttpServer.preferences(this).getBoolean("lan", false));
        allowLan.setOnCheckedChangeListener((button, checked) -> {
            SpiderHttpServer.preferences(this).edit().putBoolean("lan", checked).apply();
            Toast.makeText(this, "已保存。停止并重新启动服务后生效。", Toast.LENGTH_LONG).show();
            refresh();
        });
        content.addView(allowLan);

        addText(content, "推荐 Windows 通过 ADB 转发连接本机端口。手机端无需 Root。\n" +
                "Windows: adb forward tcp:18777 tcp:" + GatewayContract.PORT + "\n" +
                "Windows: NETPAN_TYPE3_GATEWAY_URL=http://127.0.0.1:18777\n" +
                "模式: NETPAN_TYPE3_GATEWAY_MODE=always\n" +
                "详情见仓库 android-spider-gateway/README.md",
                13, Color.DKGRAY);
        addText(content, "注意：第三方 Spider 可以运行其自带 Java/Android 原生代码。" +
                "仅使用可信的源；本精简宿主不保证所有加固插件可运行。" +
                "Android 返回本地媒体代理地址时，Windows 目前会拒绝直接下载。",
                13, Color.rgb(130, 62, 34));
        setContentView(scroll);
        refresh();
    }

    @Override protected void onResume() {
        super.onResume();
        if (status != null) refresh();
    }

    private TextView addText(LinearLayout root, String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setPadding(0, 12, 0, 12);
        root.addView(view);
        return view;
    }

    private void refreshSoon() {
        ui.postDelayed(this::refresh, 450);
        ui.postDelayed(this::refresh, 1500);
    }

    private void refresh() {
        if (status == null) return;
        status.setText(GatewayService.running() ? "运行中（前台服务）"
                : "未运行" + (GatewayService.lastError().isEmpty() ? "" : "：" + GatewayService.lastError()));
        boolean lan = SpiderHttpServer.preferences(this).getBoolean("lan", false);
        address.setText("本机健康检查：http://127.0.0.1:" + GatewayContract.PORT + "/v1/spider/health\n"
                + (lan ? "局域网：http://" + localIpv4() + ":" + GatewayContract.PORT : "局域网监听：关闭"));
        token.setText("Bearer Token（不要共享）：\n" + SpiderHttpServer.token(this));
    }

    private static String localIpv4() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface iface = interfaces.nextElement();
                if (!iface.isUp() || iface.isLoopback()) continue;
                Enumeration<InetAddress> addresses = iface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress addr = addresses.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress() && !addr.isLinkLocalAddress())
                        return addr.getHostAddress();
                }
            }
        } catch (Exception ignored) {}
        return "设备IP";
    }
}
