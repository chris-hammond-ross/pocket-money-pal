plugins {
    `kotlin-dsl`
}

dependencies {
    // The one place the Android Gradle Plugin's version is set.
    implementation("com.android.tools.build:gradle:9.5.1")
    // Firebase's config plugin, for pmp.firebase (the parents' app). It must sit beside AGP: its
    // classes need AGP's, so it can't be loaded from a module's own plugins block.
    implementation("com.google.gms:google-services:4.6.0")
}
