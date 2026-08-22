# PingPong Production Release Package

This package is hardened for a real production deployment, but provider-specific secrets and the real production domain cannot be safely invented. Before release, supply the values below.

## 1. Android production URL
Create `android/local.properties` (do not commit it):

```properties
WEB_APP_URL=https://YOUR_REAL_PRODUCTION_DOMAIN/
ALLOW_CLEARTEXT=false
```

The release build now refuses to use the old placeholder URL.

## 2. Release signing
Create one permanent Android upload/release keystore and back it up securely. Then export:

```bash
export PINGPONG_KEYSTORE_FILE=/absolute/path/to/pingpong-release.jks
export PINGPONG_KEYSTORE_PASSWORD='...'
export PINGPONG_KEY_ALIAS='pingpong'
export PINGPONG_KEY_PASSWORD='...'
```

Never commit the keystore or passwords.

## 3. Build on Termux/Linux
From the project root:

```bash
export WEB_APP_URL='https://YOUR_REAL_PRODUCTION_DOMAIN/'
export PINGPONG_KEYSTORE_FILE='/absolute/path/to/pingpong-release.jks'
export PINGPONG_KEYSTORE_PASSWORD='...'
export PINGPONG_KEY_ALIAS='pingpong'
export PINGPONG_KEY_PASSWORD='...'
cd android
./gradlew :app:bundleRelease :app:assembleRelease
```

If Gradle 8.9 is not cached, the wrapper needs internet once to download it.

## 4. Server production environment
Copy `.env.production.example` to `.env` and replace every `YOUR_`/`REPLACE_WITH_` value. At minimum, production voice requires:

- `VOICE_MODE=sfu`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- TURN/STUN configuration
- production CORS origin
- PostgreSQL and Redis when running clustered production

## 5. Before Play Console upload
- Verify the AAB is signed.
- Install the release APK on a real Android 13+ device.
- Test OTP/Google login, microphone, camera, file upload, voice seat changes, reconnect, background voice, room join/leave, gifts/wallet, and logout.
- Verify Firebase authorized domains and authentication providers.
- Verify LiveKit and TURN from a mobile network, not only Wi-Fi.
- Complete Play Console Data Safety, privacy policy, app access, content rating, and account-deletion requirements applicable to the final feature set.

## Important
A source ZIP cannot contain the user's real production URL, Firebase/LiveKit/TURN secrets, or a securely held signing key unless the user explicitly supplies them. This package therefore contains the production-safe structure and build checks, while those environment-specific values remain external.
