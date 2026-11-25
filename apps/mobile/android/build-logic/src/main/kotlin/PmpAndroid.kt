/** SDK levels for every module (ADR 0032). */
object PmpAndroid {
    const val COMPILE_SDK = 37
    const val MIN_SDK = 26
    // Play's requirement for new apps. Raising it changes Android 16's handling of the kiosk's
    // landscape lock (see kiosk's AndroidManifest.xml).
    const val TARGET_SDK = 36
}
