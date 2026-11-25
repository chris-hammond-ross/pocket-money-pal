// What every Pocket Money Pal app shares (ADR 0032, ADR 0034): SDK levels, Java, the version
// (the repo's), and release signing with the upload key. Each app module applies this and adds
// its own package, build types and anything native.
import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

// apps/mobile/android → the repo root.
val repoRoot = rootDir.parentFile.parentFile.parentFile

// The app's version is the repo's version (the release workflow sets it from the tag).
@Suppress("UNCHECKED_CAST")
val appVersion = (JsonSlurper().parse(repoRoot.resolve("package.json")) as Map<String, Any>)["version"] as String
val (major, minor, patch) = appVersion.split("-")[0].split(".").map { it.toInt() }
// 1.2.3 → 1002003. `-Ppmp.versionCode=N` overrides it, to test an update over an install.
val appVersionCode =
    (findProperty("pmp.versionCode") as String?)?.toInt() ?: (major * 1_000_000 + minor * 1_000 + patch)

// The upload key lives outside the repo (see apps/mobile/README.md). `-Ppmp.signing=<file>`
// or PMP_ANDROID_SIGNING points at its properties file.
val signingFile = file(
    (findProperty("pmp.signing") as String?)
        ?: System.getenv("PMP_ANDROID_SIGNING")
        ?: "${System.getProperty("user.home")}/.pocket-money-pal/android-upload.properties",
)
val signing = Properties().apply { if (signingFile.exists()) signingFile.inputStream().use { load(it) } }

android {
    compileSdk = PmpAndroid.COMPILE_SDK

    defaultConfig {
        minSdk = PmpAndroid.MIN_SDK
        targetSdk = PmpAndroid.TARGET_SDK
        versionCode = appVersionCode
        versionName = appVersion
    }

    signingConfigs {
        create("upload") {
            if (signingFile.exists()) {
                storeFile = signingFile.parentFile.resolve(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (signingFile.exists()) signingConfigs.getByName("upload") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        resValues = true
        buildConfig = true
    }
}

// A release without the upload key stops here, saying where it looked. Debug builds don't need it.
afterEvaluate {
    tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
        doFirst {
            if (!signingFile.exists()) {
                throw GradleException("No upload key at $signingFile (see apps/mobile/README.md).")
            }
        }
    }
}
