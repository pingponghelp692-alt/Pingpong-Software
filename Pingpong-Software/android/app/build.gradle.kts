import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val localProperties = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use(::load)
}

fun prop(name: String, default: String): String =
    providers.gradleProperty(name).orElse(localProperties.getProperty(name, default)).get()

android {
    namespace = "com.pingpong.voice"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pingpong.voice"
        minSdk = 24
        targetSdk = 35
        versionCode = 3
        versionName = "1.2.0"

        buildConfigField("String", "WEB_APP_URL", "\"${prop("WEB_APP_URL", "https://pingpong-software-production.up.railway.app/").replace("\"", "\\\"")}\"")
        buildConfigField("boolean", "ALLOW_CLEARTEXT", prop("ALLOW_CLEARTEXT", "false"))
        manifestPlaceholders["allowCleartext"] = prop("ALLOW_CLEARTEXT", "false")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    signingConfigs {
        create("release") {
            val storeFilePath = providers.environmentVariable("PINGPONG_KEYSTORE_FILE").orNull
            val storePasswordValue = providers.environmentVariable("PINGPONG_KEYSTORE_PASSWORD").orNull
            val keyAliasValue = providers.environmentVariable("PINGPONG_KEY_ALIAS").orNull
            val keyPasswordValue = providers.environmentVariable("PINGPONG_KEY_PASSWORD").orNull

            val hasRealSigningKey = !storeFilePath.isNullOrBlank() &&
                !storePasswordValue.isNullOrBlank() &&
                !keyAliasValue.isNullOrBlank() &&
                !keyPasswordValue.isNullOrBlank()

            if (hasRealSigningKey) {
                // Real, provided signing key (e.g. the original Play Store upload key).
                storeFile = file(storeFilePath!!)
                storePassword = storePasswordValue
                keyAlias = keyAliasValue
                keyPassword = keyPasswordValue
            } else {
                // -------------------------------------------------------------
                // LOCAL-ONLY FALLBACK KEYSTORE
                //
                // No PINGPONG_KEYSTORE_FILE / PINGPONG_KEYSTORE_PASSWORD /
                // PINGPONG_KEY_ALIAS / PINGPONG_KEY_PASSWORD env vars were set,
                // and no existing keystore was found in the project. To keep
                // `assembleRelease` buildable for local testing, a throwaway
                // keystore is auto-generated the first time it's needed.
                //
                // See keystore/LOCAL_KEYSTORE_README.md.
                //
                // *** THIS KEYSTORE IS NOT YOUR PLAY STORE SIGNING KEY. ***
                // An APK signed with it can be installed and tested locally,
                // but Google Play will REJECT it as an update to an app that
                // was already published under a different signing key. Only
                // use it until the original release key is recovered, or
                // until you deliberately decide to do a Play Console signing
                // key reset for this app.
                // -------------------------------------------------------------
                val localKeystoreDir = rootProject.file("keystore")
                val localKeystoreFile = File(localKeystoreDir, "pingpong-local-release.jks")
                val localAlias = "pingpong-local"
                val localPassword = "pingpongLocalOnly2026"

                if (!localKeystoreFile.exists()) {
                    localKeystoreDir.mkdirs()
                    val keytoolExe = File(File(System.getProperty("java.home"), "bin"), "keytool").absolutePath
                    project.exec {
                        commandLine(
                            keytoolExe, "-genkeypair", "-v",
                            "-keystore", localKeystoreFile.absolutePath,
                            "-alias", localAlias,
                            "-keyalg", "RSA",
                            "-keysize", "2048",
                            "-validity", "10000",
                            "-storepass", localPassword,
                            "-keypass", localPassword,
                            "-dname", "CN=PingPong Local Dev, OU=Dev, O=PingPong, L=Local, ST=Local, C=US"
                        )
                    }
                    logger.warn(
                        "\n" +
                        "==================================================================\n" +
                        " PINGPONG: No release signing env vars found.\n" +
                        " Generated a LOCAL-ONLY release keystore at:\n" +
                        "   ${localKeystoreFile.absolutePath}\n" +
                        " This is NOT your original Play Store signing key.\n" +
                        " Do not upload an APK signed with it as an update to an app\n" +
                        " already published under a different key.\n" +
                        " See keystore/LOCAL_KEYSTORE_README.md for details.\n" +
                        "=================================================================="
                    )
                }

                storeFile = localKeystoreFile
                storePassword = localPassword
                keyAlias = localAlias
                keyPassword = localPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    packaging {
        resources {
            excludes += setOf("META-INF/NOTICE.md", "META-INF/LICENSE.md", "META-INF/LICENSE-notice.md")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
}
