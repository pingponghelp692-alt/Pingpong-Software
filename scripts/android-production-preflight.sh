#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID="$ROOT/android"

: "${WEB_APP_URL:?Set WEB_APP_URL to your real HTTPS production domain}"
case "$WEB_APP_URL" in
  https://*) ;;
  *) echo "ERROR: WEB_APP_URL must use https://" >&2; exit 1;;
esac

if [[ "$WEB_APP_URL" == *"YOUR_"* || "$WEB_APP_URL" == *"example"* ]]; then
  echo "ERROR: WEB_APP_URL is still a placeholder." >&2
  exit 1
fi

for v in PINGPONG_KEYSTORE_FILE PINGPONG_KEYSTORE_PASSWORD PINGPONG_KEY_ALIAS PINGPONG_KEY_PASSWORD; do
  if [[ -z "${!v:-}" ]]; then echo "ERROR: missing $v" >&2; exit 1; fi
done
[[ -f "$PINGPONG_KEYSTORE_FILE" ]] || { echo "ERROR: keystore not found: $PINGPONG_KEYSTORE_FILE" >&2; exit 1; }

cd "$ANDROID"
cat > local.properties <<PROPS
WEB_APP_URL=$WEB_APP_URL
ALLOW_CLEARTEXT=false
PROPS

./gradlew :app:bundleRelease :app:assembleRelease

echo "Release build completed. Check android/app/build/outputs/bundle/release/app-release.aab"
echo "APK: android/app/build/outputs/apk/release/app-release.apk"
