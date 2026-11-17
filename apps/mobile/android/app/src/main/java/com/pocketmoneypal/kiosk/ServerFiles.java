package com.pocketmoneypal.kiosk;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The server bundle (server.mjs, drizzle/, web/) ships in the APK's assets, staged by
 * scripts/stage-server.mjs. Node reads files, so it's copied to private storage on the first
 * run and again whenever the APK carries a different stage (an update). The family's data lives
 * elsewhere (see {@link ServerService#dataDir}), so replacing these files never touches it.
 */
final class ServerFiles {
    private static final String ASSET_DIR = "server";
    private static final String MARKER = "stage.txt";

    private ServerFiles() {}

    /** The folder holding server.mjs, up to date with this APK. */
    static File prepare(Context context) throws IOException {
        AssetManager assets = context.getAssets();
        File dir = new File(context.getFilesDir(), ASSET_DIR);
        File marker = new File(dir, MARKER);
        String staged = readAll(assets.open(ASSET_DIR + "/" + MARKER));
        if (marker.exists() && staged.equals(readAll(new java.io.FileInputStream(marker)))) {
            return dir;
        }
        deleteTree(dir);
        copyTree(assets, ASSET_DIR, dir);
        // Written last: a copy cut short by a kill is redone on the next start.
        try (OutputStream out = new FileOutputStream(marker)) {
            out.write(staged.getBytes(StandardCharsets.UTF_8));
        }
        return dir;
    }

    private static void copyTree(AssetManager assets, String path, File target) throws IOException {
        String[] children = assets.list(path);
        if (children == null || children.length == 0) {
            if (path.endsWith("/" + MARKER)) return;
            try (InputStream in = assets.open(path); OutputStream out = new FileOutputStream(target)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return;
        }
        if (!target.isDirectory() && !target.mkdirs()) throw new IOException("can't create " + target);
        for (String child : children) copyTree(assets, path + "/" + child, new File(target, child));
    }

    static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream input = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = input.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name()).trim();
        }
    }
}
