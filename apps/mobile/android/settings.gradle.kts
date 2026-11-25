pluginManagement {
    // The shared build setup: the pmp.android-app and pmp.android-library plugins (ADR 0034).
    includeBuild("build-logic")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "pocket-money-pal"
// One Gradle project, one module per app (ADR 0033): kiosk is the kids' screen and the server;
// parent is the parents' app; shell is what the apps share.
include(":kiosk", ":parent", ":shell")
