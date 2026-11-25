package com.pocketmoneypal.kiosk;

/** Node for Android (fogtape/nodejs-mobile, ADR 0029), through the JNI bridge in cpp/. */
final class NodeRuntime {
    static {
        System.loadLibrary("node");
        System.loadLibrary("pmpnode");
    }

    private NodeRuntime() {}

    /**
     * Sets each "NAME=value" in {@code env}, changes to {@code cwd} and runs Node with {@code
     * args} ({@code args[0]} is the program name). Blocks until Node exits; returns its exit code.
     * Callable once per process.
     */
    static native int start(String[] args, String[] env, String cwd);
}
