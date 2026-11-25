// An Android library shared by the apps (the `shell` module): the same SDK levels and Java.
plugins {
    id("com.android.library")
}

android {
    compileSdk = PmpAndroid.COMPILE_SDK
    defaultConfig { minSdk = PmpAndroid.MIN_SDK }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
