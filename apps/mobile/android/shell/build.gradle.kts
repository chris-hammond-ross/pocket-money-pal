// What the apps share (ADR 0033, ADR 0034, ADR 0035): the WebView setup, the page↔app bridge,
// the theme and colours. It adds nothing to an app that doesn't use it: the bridge needs
// androidx.webkit, which is compile-only here, so only an app that uses NativeBridge (the
// parents' app) ships it. The kiosk app never touches the bridge.
plugins {
    id("pmp.android-library")
}

android {
    namespace = "com.pocketmoneypal.shell"
}

dependencies {
    compileOnly(PmpAndroid.WEBKIT)
}
