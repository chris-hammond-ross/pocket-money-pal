package com.pocketmoneypal.kiosk;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.Process;
import android.util.Log;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Runs the server: Node with the bundled server.mjs, in a {@code specialUse} foreground service
 * in its own process (":server"), as Electron forks it on the PC (ADR 0001, ADR 0029). It holds
 * a partial wake lock and a Wi-Fi lock, so phones on the Wi-Fi and the relay tunnel keep working
 * with the screen off. Node can start only once per process, so when Node exits the service
 * stops and its process ends; the activity or the next boot starts it again.
 */
public final class ServerService extends Service {
    static final String TAG = "PmpShell";
    static final int PORT = 4789;
    private static final String CHANNEL = "server";
    private static final int NOTIFICATION_ID = 1;

    /** Node has been started in this process (it can't be started twice). */
    private static volatile boolean nodeStarted;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.WifiLock wifiLowLatencyLock;

    /** Starts the service (and so the server) if it isn't running. Safe to call often. */
    static void start(Context context) {
        context.startForegroundService(new Intent(context, ServerService.class));
    }

    /** Where the family's database and pictures live: private, and never in Android's backups. */
    static File dataDir(Context context) {
        return new File(context.getNoBackupFilesDir(), "data");
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        acquireLocks();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!nodeStarted) {
            nodeStarted = true;
            new Thread(this::runNode, "node").start();
        }
        return START_STICKY;
    }

    private void runNode() {
        int code = -1;
        try {
            File serverDir = ServerFiles.prepare(this);
            File data = dataDir(this);
            File tmp = new File(getCacheDir(), "tmp");
            //noinspection ResultOfMethodCallIgnored
            data.mkdirs();
            //noinspection ResultOfMethodCallIgnored
            tmp.mkdirs();
            String[] args = {"node", new File(serverDir, "server.mjs").getAbsolutePath()};
            List<String> env = new ArrayList<>(Arrays.asList(
                "PMP_PORT=" + PORT,
                "PMP_DB_PATH=" + new File(data, "pmp.db").getAbsolutePath(),
                "PMP_APP_VERSION=" + versionName(),
                "PMP_PLATFORM=android",
                // Android has no /tmp; backups and restores use the temp folder (fogtape's EMBEDDING.md).
                "TMPDIR=" + tmp.getAbsolutePath(),
                "HOME=" + getFilesDir().getAbsolutePath(),
                // node:sqlite is still marked experimental in Node 24 (ADR 0029).
                "NODE_OPTIONS=--disable-warning=ExperimentalWarning --max-old-space-size=512",
                "NODE_COMPILE_CACHE=" + new File(getCacheDir(), "node-compile-cache").getAbsolutePath(),
                "NODE_COMPILE_CACHE_PORTABLE=1"));
            // Debug builds use the staging relay; release builds the server's default.
            if (!BuildConfig.RELAY_URL.isEmpty()) env.add("PMP_RELAY_URL=" + BuildConfig.RELAY_URL);
            Log.i(TAG, "starting the server " + versionName());
            code = NodeRuntime.start(args, env.toArray(new String[0]), getFilesDir().getAbsolutePath());
        } catch (Throwable t) {
            Log.e(TAG, "the server couldn't start", t);
        }
        Log.w(TAG, "the server stopped (code " + code + ")");
        // Stopped first, so Android doesn't restart a server that exits on its own (say, the
        // port is taken); the activity offers to try again. Then end the process: Node can't
        // run twice in it.
        stopSelf();
        Process.killProcess(Process.myPid());
    }

    // No timeout: the server has to answer phones for as long as it runs (ADR 0029).
    @SuppressLint("WakelockTimeout")
    private void acquireLocks() {
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pmp:server");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();

        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        // HIGH_PERF keeps Wi-Fi awake with the screen off up to Android 13 (it does nothing from
        // 14). LOW_LATENCY (10+) works while the app is in front with the screen on.
        //noinspection deprecation
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "pmp:server");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();
        if (Build.VERSION.SDK_INT >= 29) {
            wifiLowLatencyLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "pmp:server-ll");
            wifiLowLatencyLock.setReferenceCounted(false);
            wifiLowLatencyLock.acquire();
        }
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null) wakeLock.release();
        if (wifiLock != null) wifiLock.release();
        if (wifiLowLatencyLock != null) wifiLowLatencyLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, getString(R.string.channel_server), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.channel_server_description));
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Notification.Builder builder = new Notification.Builder(this, CHANNEL);
        builder.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(getString(R.string.notification_text))
                .setOngoing(true)
                .setShowWhen(false)
                // Unpair all phones isn't here: kids can reach the notification shade. It's in
                // Android's Settings for the app, behind the screen lock (UnpairActivity, ADR 0032).
                .setContentIntent(activity(MainActivity.class, null, 0));
        if (Build.VERSION.SDK_INT >= 31) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    private PendingIntent activity(Class<?> target, String action, int requestCode) {
        Intent intent = new Intent(this, target).setAction(action);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(this, requestCode, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private String versionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "0.0.0";
        }
    }
}
