# Local-only release keystore

`pingpong-local-release.jks` in this folder (if present) was **auto-generated
by the Gradle build**, not supplied by you. It is created automatically the
first time `assembleRelease` runs and no `PINGPONG_KEYSTORE_FILE` /
`PINGPONG_KEYSTORE_PASSWORD` / `PINGPONG_KEY_ALIAS` / `PINGPONG_KEY_PASSWORD`
environment variables are set.

- Alias: `pingpong-local`
- Store/key password: `pingpongLocalOnly2026`
- Validity: ~27 years (10000 days), RSA 2048

## What this is for

Letting `./gradlew clean assembleRelease` produce a **validly signed,
installable APK** for local testing/QA on-device, even when the real
production signing key isn't available in this environment.

## What this is NOT for

**This is not your Play Store upload/signing key.** If PingPong has ever
been published to the Play Store (or shared with testers) under a different
key, an APK signed with this local keystore:

- Cannot be uploaded as an update to that existing Play Store listing —
  Play Console will reject it with a signature mismatch.
- Cannot be installed over-the-top of an existing install of the app signed
  with the real key — Android will refuse to install it ("app not
  installed", signature conflict) unless the old copy is uninstalled first.

## Using your real signing key instead

If you have (or recover) the original release keystore, don't use this
fallback — set these environment variables before building, and the build
will use the real key automatically instead of generating/using this one:

```bash
export PINGPONG_KEYSTORE_FILE=/absolute/path/to/your-real-release.jks
export PINGPONG_KEYSTORE_PASSWORD='...'
export PINGPONG_KEY_ALIAS='...'
export PINGPONG_KEY_PASSWORD='...'
./gradlew clean assembleRelease
```

## Security note

This file is intentionally excluded from version control via `.gitignore`.
Because its password is hardcoded and public (in `app/build.gradle.kts`),
treat any APK signed with it as **untrusted for production distribution**,
even though it is a technically valid, verifiable signature for local use.
