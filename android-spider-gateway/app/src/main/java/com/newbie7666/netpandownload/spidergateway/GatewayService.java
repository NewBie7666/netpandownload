package com.newbie7666.netpandownload.spidergateway;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

public final class GatewayService extends Service {
    public static final String ACTION_START = "com.newbie7666.spidergateway.START";
    public static final String ACTION_STOP = "com.newbie7666.spidergateway.STOP";
    private static final String CHANNEL_ID = "netpan-spider-host";
    private static final int NOTIFICATION_ID = 7001;
    private SpiderHttpServer server;
    private static volatile boolean running;
    private static volatile String error = "";

    static boolean running() { return running; }
    static String lastError() { return error; }

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                    "Spider Gateway", NotificationManager.IMPORTANCE_LOW);
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            manager.createNotificationChannel(channel);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, notification());
        if (server == null) {
            try {
                server = new SpiderHttpServer(this);
                boolean lan = SpiderHttpServer.preferences(this).getBoolean("lan", false);
                server.start(lan);
                error = "";
                running = true;
            } catch (Exception e) {
                error = e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage());
                running = false;
                Log.e("NetPanSpiderGateway", "Cannot start gateway", e);
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        return START_STICKY;
    }

    private Notification notification() {
        Intent launch = new Intent(this, GatewayActivity.class);
        int immutable = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent content = PendingIntent.getActivity(this, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | immutable);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        return builder.setContentTitle("NetPan Spider Gateway")
                .setContentText("Android Spider 解析服务正在运行（端口 " + GatewayContract.PORT + "）")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .setContentIntent(content).build();
    }

    @Override public void onDestroy() {
        running = false;
        if (server != null) {
            server.stop();
            server = null;
        }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
