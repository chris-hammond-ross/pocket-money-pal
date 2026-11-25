// The kiosk app: the kids' screen, and the server it runs (ADR 0032). Versions, SDK levels and
// signing come from pmp.android-app (build-logic/); what's here is the kiosk's own.
import groovy.json.JsonSlurper

plugins {
    id("pmp.android-app")
}

// apps/mobile/android/kiosk → apps/mobile.
val mobileDir = rootDir.parentFile

@Suppress("UNCHECKED_CAST")
fun readJson(file: File): Map<String, Any> = JsonSlurper().parse(file) as Map<String, Any>

// Node for Android (ADR 0029), unpacked by scripts/fetch-node.mjs.
val nodeVersion = readJson(mobileDir.resolve("node-mobile.json"))["version"] as String
val nodeDir = mobileDir.resolve(".cache/node-$nodeVersion")
// The server, web app and migrations, staged by scripts/stage-server.mjs.
val stageDir = mobileDir.resolve(".stage/assets")

// Every ABI Node for Android ships. `-Ppmp.abi=arm64-v8a` builds a smaller APK for one device;
// Play splits the bundle per device by itself.
val abis = (findProperty("pmp.abi") as String?)?.split(",") ?: listOf("arm64-v8a", "armeabi-v7a", "x86_64")

android {
    namespace = "com.pocketmoneypal.kiosk"

    defaultConfig {
        applicationId = "com.pocketmoneypal.kiosk"
        ndk { abiFilters += abis }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DNODE_DIR=${nodeDir.absolutePath}", "-DANDROID_STL=c++_shared")
            }
        }
    }

    buildTypes {
        debug {
            // Installs beside a release build. Both use port 4789, so only one runs at a time.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            resValue("string", "app_name", "Kids (debug)")
            // The staging relay, so testing remote access never moves a real licence (ADR 0021).
            buildConfigField("String", "RELAY_URL", "\"https://staging.pocketmoneypal.app\"")
        }
        release {
            // The launcher label (ADR 0033). The Play title is "Pocket Money Pal: Kids Board";
            // inside the code it's still the kiosk.
            resValue("string", "app_name", "Kids Board")
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
}

dependencies {
    implementation(project(":shell"))
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
