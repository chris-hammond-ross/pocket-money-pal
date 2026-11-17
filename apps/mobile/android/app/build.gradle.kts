import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

// apps/mobile/android/app → the repo root, and apps/mobile.
val mobileDir = rootDir.parentFile
val repoRoot = mobileDir.parentFile.parentFile

@Suppress("UNCHECKED_CAST")
fun readJson(file: File): Map<String, Any> = JsonSlurper().parse(file) as Map<String, Any>

// The app's version is the repo's version (the release workflow sets it from the tag).
val appVersion = readJson(repoRoot.resolve("package.json"))["version"] as String
val (major, minor, patch) = appVersion.split("-")[0].split(".").map { it.toInt() }
// 1.2.3 → 1002003. `-Ppmp.versionCode=N` overrides it, to test an update over an install.
val appVersionCode =
    (findProperty("pmp.versionCode") as String?)?.toInt() ?: (major * 1_000_000 + minor * 1_000 + patch)

// Node for Android (ADR 0029), unpacked by scripts/fetch-node.mjs.
val nodeVersion = readJson(mobileDir.resolve("node-mobile.json"))["version"] as String
val nodeDir = mobileDir.resolve(".cache/node-$nodeVersion")
// The server, web app and migrations, staged by scripts/stage-server.mjs.
val stageDir = mobileDir.resolve(".stage/assets")

// The upload key lives outside the repo (see apps/mobile/README.md). `-Ppmp.signing=<file>`
// or PMP_ANDROID_SIGNING points at its properties file.
val signingFile = file(
    (findProperty("pmp.signing") as String?)
        ?: System.getenv("PMP_ANDROID_SIGNING")
        ?: "${System.getProperty("user.home")}/.pocket-money-pal/android-upload.properties",
)
val signing = Properties().apply { if (signingFile.exists()) signingFile.inputStream().use { load(it) } }

// Every ABI Node for Android ships. `-Ppmp.abi=arm64-v8a` builds a smaller APK for one device;
// Play splits the bundle per device by itself.
val abis = (findProperty("pmp.abi") as String?)?.split(",") ?: listOf("arm64-v8a", "armeabi-v7a", "x86_64")

android {
    namespace = "com.pocketmoneypal.kiosk"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.pocketmoneypal.kiosk"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersion
        ndk { abiFilters += abis }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DNODE_DIR=${nodeDir.absolutePath}", "-DANDROID_STL=c++_shared")
            }
        }
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
        debug {
            // Installs beside a release build. Both use port 4789, so only one runs at a time.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            resValue("string", "app_name", "PMP (debug)")
            // The staging relay, so testing remote access never moves a real licence (ADR 0021).
            buildConfigField("String", "RELAY_URL", "\"https://staging.pocketmoneypal.app\"")
        }
        release {
            isMinifyEnabled = false
            signingConfig = if (signingFile.exists()) signingConfigs.getByName("upload") else null
            resValue("string", "app_name", "Pocket Money Pal")
            buildConfigField("String", "RELAY_URL", "\"\"") // the server's default: production
        }
    }

    externalNativeBuild {
        cmake { path = file("src/main/cpp/CMakeLists.txt") }
    }

    sourceSets {
        getByName("main") {
            jniLibs.directories.add(nodeDir.resolve("jniLibs").absolutePath)
            assets.directories.add(stageDir.absolutePath)
        }
    }

    packaging {
        // Keep the libraries uncompressed and page-aligned in the APK: Android maps them
        // straight from it, so libnode.so isn't stored twice on the device.
        jniLibs { useLegacyPackaging = false }
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

// Fail early, with what to run, when the downloaded or staged parts are missing.
val checkInputs = tasks.register("checkInputs") {
    doLast {
        if (!nodeDir.resolve(".complete").exists()) {
            throw GradleException("Node for Android is missing. Run: npm run fetch-node -w @pmp/mobile")
        }
        if (!stageDir.resolve("server/server.mjs").exists()) {
            throw GradleException("The server isn't staged. Run: npm run build && npm run stage -w @pmp/mobile")
        }
    }
}
tasks.named("preBuild") { dependsOn(checkInputs) }

afterEvaluate {
    tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
        doFirst {
            if (!signingFile.exists()) {
                throw GradleException("No upload key at $signingFile (see apps/mobile/README.md).")
            }
        }
    }
}
