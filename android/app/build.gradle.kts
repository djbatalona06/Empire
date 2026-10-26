plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Debug talks to the Worker on your computer. 10.0.2.2 is "my computer" from inside the Android emulator.
// On a real phone: ./gradlew installDebug -PapiBaseUrl=http://<your-mac-ip>:8787
val debugApi = (project.findProperty("apiBaseUrl") as String?) ?: "http://10.0.2.2:8787"

android {
    namespace = "com.dealerdoor.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dealerdoor.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Lets UI tests save screenshots that Gradle copies off the device.
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
        // Host in the sign-in email links. Set to your real API domain before release (see docs/08).
        manifestPlaceholders["appLinkHost"] = (project.findProperty("appLinkHost") as String?) ?: "api.example.com"
    }

    buildTypes {
        debug {
            buildConfigField("String", "API_BASE_URL", "\"$debugApi\"")
        }
        release {
            buildConfigField("String", "API_BASE_URL", "\"https://api.example.com\"")
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        animationsDisabled = true
    }
    lint {
        abortOnError = true
        warningsAsErrors = false
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.fragment)
    implementation(libs.androidx.biometric)
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.osmdroid)
    implementation(libs.stripe)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.storage)
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestUtil(libs.androidx.test.services)
}
