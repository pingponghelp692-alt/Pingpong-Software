# PingPong Android

This Android Studio project is an additive WebView shell around the existing PingPong web application. The original Node/Express backend and public website are intentionally untouched.

## Build configuration

Set the production website URL with a Gradle property or environment variable:

```text
WEB_APP_URL=https://your-production-domain.example/
```

For a local HTTP-only test server, explicitly enable cleartext traffic for that build:

```text
ALLOW_CLEARTEXT=true
WEB_APP_URL=http://192.168.x.x:3000/
```

Do not use cleartext in a Play production build.

## Release signing

The release build reads these environment variables when present:

- `PINGPONG_KEYSTORE_FILE`
- `PINGPONG_KEYSTORE_PASSWORD`
- `PINGPONG_KEY_ALIAS`
- `PINGPONG_KEY_PASSWORD`

If they are not supplied, the build auto-generates and uses a local-only fallback keystore under `keystore/` so `assembleRelease` still produces a validly-signed, installable APK. That fallback key is **not** a Play Store upload key — see `keystore/LOCAL_KEYSTORE_README.md` before distributing anything.

## Building on Termux (Android/aarch64)

See `BUILD_TERMUX.md` for the on-device build setup, the AAPT2 override needed on Termux, and how to verify the resulting APK signature with `apksigner`.

## Release artifacts

```bash
./gradlew assembleRelease
./gradlew bundleRelease
```

APK: `app/build/outputs/apk/release/app-release.apk`

AAB: `app/build/outputs/bundle/release/app-release.aab`

## WebView capabilities

- JavaScript + DOM storage + cookies
- Third-party cookies for Firebase/OAuth flows
- WebRTC camera/microphone permission bridge
- File upload chooser
- DownloadManager integration
- Popup WebView support for Firebase Google sign-in flows
- Android 13+ notification permission/channel
- Android splash screen
- Adaptive launcher icon
- R8/ProGuard release configuration

The app does not duplicate or replace the existing website authentication, room, voice, wallet, game, admin, or API logic.
