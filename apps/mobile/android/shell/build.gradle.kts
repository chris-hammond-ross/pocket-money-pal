// What the apps share (ADR 0033, ADR 0034): the WebView setup, the theme and colours. No
// dependencies, so an app gets nothing it doesn't use.
plugins {
    id("pmp.android-library")
}

android {
    namespace = "com.pocketmoneypal.shell"
}
