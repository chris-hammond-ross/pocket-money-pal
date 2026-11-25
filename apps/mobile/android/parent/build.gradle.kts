// The parents' app (ADR 0033, ADR 0035): a thin shell around the family server's /parent, with
// a code scanner for pairing. Versions, SDK levels and signing come from pmp.android-app
// (build-logic/); what's here is the parents' app's own. No server inside, so no Node and no
// staging step.
plugins {
    id("pmp.android-app")
}

android {
    namespace = "com.pocketmoneypal.parent"

    defaultConfig {
        applicationId = "com.pocketmoneypal.parent"
    }

    buildTypes {
        debug {
            // Installs beside a release build.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            resValue("string", "app_name", "Parent (debug)")
        }
        release {
            // The launcher label (ADR 0033). The Play title is "Pocket Money Pal: Parent".
            resValue("string", "app_name", "PMP Parent")
        }
    }
}

dependencies {
    implementation(project(":shell"))
    // The page↔app bridge (shell's NativeBridge) runs on WebViewCompat.addWebMessageListener.
    implementation(PmpAndroid.WEBKIT)
    // Google's code scanner: Play services shows the camera and hands back the code, so the app
    // needs no camera permission or scanner screen of its own (ADR 0035).
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
