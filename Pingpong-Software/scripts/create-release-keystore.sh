#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/android/pingpong-release.jks}"
ALIAS="${PINGPONG_KEY_ALIAS:-pingpong}"

if ! command -v keytool >/dev/null 2>&1; then
  echo "ERROR: keytool is not available. Install/use a JDK first." >&2
  exit 1
fi

if [[ -e "$OUT" ]]; then
  echo "ERROR: keystore already exists: $OUT" >&2
  echo "Do not overwrite an existing Play Store signing key." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
read -r -s -p "New keystore password: " STORE_PASS; echo
read -r -s -p "Confirm keystore password: " STORE_PASS2; echo
[[ "$STORE_PASS" == "$STORE_PASS2" ]] || { echo "ERROR: passwords do not match." >&2; exit 1; }

keytool -genkeypair -v \
  -keystore "$OUT" \
  -storetype PKCS12 \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -storepass "$STORE_PASS" \
  -keypass "$STORE_PASS" \
  -dname "CN=PingPong Production, OU=Mobile, O=PingPong, L=India, C=IN"

chmod 600 "$OUT"
echo "Created: $OUT"
echo "Alias: $ALIAS"
echo "Back up this keystore securely. Loss of the signing key can block future Play Store updates."
