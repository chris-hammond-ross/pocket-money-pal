package com.pocketmoneypal.kiosk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Starts the server after a reboot and after an update, so phones work without anyone opening
 * the app. Android doesn't let an app open a screen from here; the kids' screen opens from the
 * app icon or the notification (ADR 0032).
 */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }
        Log.i(ServerService.TAG, "starting the server: " + action);
        try {
            ServerService.start(context);
        } catch (RuntimeException e) {
            Log.e(ServerService.TAG, "couldn't start the server after " + action, e);
        }
    }
}
