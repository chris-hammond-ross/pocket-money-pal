/** SDK levels for every module (ADR 0032), and shared library versions. */
object PmpAndroid {
    const val COMPILE_SDK = 37
    const val MIN_SDK = 26
    // Play's requirement for new apps. Raising it changes Android 16's handling of the kiosk's
    // landscape lock (see kiosk's AndroidManifest.xml).
    const val TARGET_SDK = 36

    // Libraries more than one module names (ADR 0035). The shell compiles against the bridge's
    // androidx.webkit; the app that uses the bridge ships it.
    const val WEBKIT = "androidx.webkit:webkit:1.14.0"
}
