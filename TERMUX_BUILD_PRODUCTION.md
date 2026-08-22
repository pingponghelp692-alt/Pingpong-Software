# Termux build guide — PingPong production candidate

## 1. Put the project in Termux home

Do NOT build directly under `/storage/emulated/0/Download/...` because Android shared storage commonly blocks npm symlink creation (`EACCES`).

```bash
mkdir -p ~/pingpong
cd ~/pingpong
unzip PingPong-VOICE-PRODUCTION-FIXED-2026-08-15.zip
cd work_auto_src
```

## 2. Install the required Termux packages

```bash
pkg update -y
pkg install -y nodejs-lts openjdk-17 git unzip
java -version
node -v
npm -v
```

## 3. Install Node dependencies

```bash
cd ~/pingpong/work_auto_src
npm install
```

If the project is on shared storage, move it into `$HOME` before running `npm install`.

## 4. Configure LiveKit

Set these on the server deployment (never put the API secret in the Android/WebView client):

```bash
export VOICE_MODE=sfu
export LIVEKIT_URL='wss://YOUR-LIVEKIT-HOST'
export LIVEKIT_API_KEY='YOUR_API_KEY'
export LIVEKIT_API_SECRET='YOUR_API_SECRET'
```

Also configure the project's normal Firebase/Redis/TURN/database environment variables as required by the deployment.

## 5. Run regression tests

```bash
node test/run-all.js
node test/voiceRecoveryStatic.test.js
```

The source audit performed for this package passed **29/29 suites and 31 tests** in the available local environment.

## 6. Run the server

```bash
npm start
```

or use the project's existing PM2 configuration after installing PM2.

## 7. Configure the Android wrapper

Edit `android/local.properties` (or use the example) and set the web app URL:

```properties
WEB_APP_URL=https://YOUR-PINGPONG-DOMAIN/
ALLOW_CLEARTEXT=false
```

For a release keystore, export:

```bash
export PINGPONG_KEYSTORE_FILE="$HOME/pingpong-release.jks"
export PINGPONG_KEYSTORE_PASSWORD='YOUR_PASSWORD'
export PINGPONG_KEY_ALIAS='pingpong'
export PINGPONG_KEY_PASSWORD='YOUR_KEY_PASSWORD'
```

## 8. Build APK/AAB

```bash
cd android
chmod +x gradlew
./gradlew assembleRelease
./gradlew bundleRelease
```

Outputs:

```text
android/app/build/outputs/apk/release/app-release.apk
android/app/build/outputs/bundle/release/app-release.aab
```

## 9. Required real-device voice validation

Before public release, test on at least two Android phones:

- 1 → 2 → 4 → 8 voice participants
- take seat / leave seat / moderator move to audience
- Wi-Fi → mobile data
- mobile data → Wi-Fi
- temporary network loss for 5–15 seconds
- screen lock/unlock
- background app for several minutes
- foreground again
- Android permission revoke/regrant
- LiveKit reconnect after network handoff
- all participants can hear all seated speakers
- audience cannot publish
- no duplicate audio after reconnect
- repeated seat changes do not cut existing audio

A source-only package cannot honestly guarantee literal 100% reliability across every Android OEM, carrier and network. The candidate is hardened for those failure modes, but the final production sign-off must include this live-device/SFU test matrix.
