package com.pocketmoneypal.parent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import java.util.regex.Pattern;

/**
 * Showing the server's notifications (ADR 0037). One channel, for claims and family alerts, at
 * high importance; quiet hours are the server's business (ADR 0009). A message's {@code tag}
 * is the notification's tag, so a batch replaces the earlier notification, and it alerts only
 * once while it's still showing (as a browser's {@code renotify: false}).
 */
final class Notifications {
    static final String CHANNEL = "claims";
    /** Where a tap leads (the message's {@code url}): a path under /parent. */
    static final String EXTRA_URL = "com.pocketmoneypal.parent.URL";
    private static final int ID = 1;
    private static final Pattern PARENT_PATH = Pattern.compile("^/parent(?:[/?#].*)?$");

    private Notifications() {}

    static void createChannel(Context context) {
        NotificationChannel channel = new NotificationChannel(CHANNEL,
                context.getString(R.string.channel_claims), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(R.string.channel_claims_description));
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    /** {@code isParentPath} in @pmp/shared. */
    static boolean isParentPath(String url) {
        return url != null && url.length() <= 500 && PARENT_PATH.matcher(url).matches();
    }

    static void show(Context context, String title, String body, String tag, String url) {
        createChannel(context);
        Intent open = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .putExtra(EXTRA_URL, isParentPath(url) ? url : "/parent")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // One per tag, so a claim's tap and a payday's tap don't overwrite each other's url.
        PendingIntent tap = PendingIntent.getActivity(context, tag.hashCode(), open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(context.getColor(R.color.parent_icon_background))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .build();
        context.getSystemService(NotificationManager.class).notify(tag, ID, notification);
    }

    static void cancelAll(Context context) {
        context.getSystemService(NotificationManager.class).cancelAll();
    }
}
