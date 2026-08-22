# Building PingPong Android on Termux (ARM64)

This project builds directly on-device in Termux. Two Termux-specific issues
are already handled by the project config (see below) — you shouldn't need
to touch generated resource IDs or hand-edit signing config.

## 1. Prerequisites

```bash
pkg update
pkg install openjdk-21 aapt2
```

Confirm versions match what this project expects:

```bash
java -version        # 21.0.12+
$PREFIX/bin/aapt2 version
```

## 2. Why the build needed fixing

**AAPT2 mismatch.** AGP downloads its own `aapt2` binary from Maven
(`aapt2-8.7.3-12006047-linux`), built for glibc/x86_64 Linux. Termux is
Android/aarch64/bionic, so that binary can't execute; the shell falls back to
reading it as a text script, producing the `Syntax error: "(" unexpected`
error. This in turn breaks resource compilation and linking, which is what
produces the `No package ID 7f found for resource ID 0x7f0300xx` errors — a
downstream symptom of aapt2 never running correctly, not a resource-ID
problem to fix by hand.

**Fix (already applied):** `gradle.properties` sets

```properties
android.aapt2FromMavenOverride=/data/data/com.termux/files/usr/bin/aapt2
```

which points AGP at Termux's own native `aapt2` instead. If your Termux
prefix differs, override on the command line instead of editing the file:

```bash
./gradlew clean assembleRelease -Pandroid.aapt2FromMavenOverride=$PREFIX/bin/aapt2
```

**Signing.** `app/build.gradle.kts` now falls back to auto-generating a
local-only release keystore when the `PINGPONG_KEYSTORE_*` env vars aren't
set, so `assembleRelease` no longer NPEs on a missing `storeFile`. Details
and warnings are in `keystore/LOCAL_KEYSTORE_README.md`.

## 3. Reproducible build command

```bash
cd src/android

# Optional: use your real Play Store signing key instead of the
# auto-generated local-only one.
# export PINGPONG_KEYSTORE_FILE=/absolute/path/to/real-release.jks
# export PINGPONG_KEYSTORE_PASSWORD='...'
# export PINGPONG_KEY_ALIAS='...'
# export PINGPONG_KEY_PASSWORD='...'

# Optional: production web app URL (falls back to local.properties/blank)
export WEB_APP_URL=https://your-production-domain.example/

chmod +x ./gradlew
./gradlew clean assembleRelease
```

Output APK:

```
app/build/outputs/apk/release/app-release.apk
```

## 4. Verifying the signature

`build-tools` ships `apksigner`. Locate it and verify:

```bash
find $PREFIX -iname apksigner 2>/dev/null
# e.g. $PREFIX/opt/android-sdk/build-tools/<version>/apksigner
# or, if using the Termux 'aapt2'-style standalone build-tools package,
# wherever that package installs it.

APKSIGNER=$(find $PREFIX -iname apksigner 2>/dev/null | head -n1)

"$APKSIGNER" verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

Expected: `Verified using v2/v3 scheme (APK Signature Scheme v2/v3): true`
and a printed certificate fingerprint. If you're on the auto-generated local
fallback keystore, the certificate CN will read `PingPong Local Dev` — that
confirms you're on the local-only key described in
`keystore/LOCAL_KEYSTORE_README.md`, not a production key.

## 5. If `apksigner` isn't installed

Install Android SDK build-tools via Termux's `android-tools`/SDK packaging
of your choice, or use the JDK's `jarsigner` as a fallback sanity check
(it verifies the JAR/APK signature but doesn't validate APK Signature Scheme
v2/v3 the way `apksigner` does):

```bash
jarsigner -verify -verbose -certs app/build/outputs/apk/release/app-release.apk
```
