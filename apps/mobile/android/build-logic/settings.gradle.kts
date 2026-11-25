// Build setup the app modules share: SDK levels, versions and signing (ADR 0034). Included by
// ../settings.gradle.kts, so its plugins apply by id with no version.
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "build-logic"
