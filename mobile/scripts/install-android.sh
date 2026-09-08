#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADB_DEFAULT="$HOME/Library/Android/sdk/platform-tools/adb"
VARIANT="${1:-debug}"

case "$VARIANT" in
  debug) APK="$MOBILE_DIR/android/app/build/outputs/apk/debug/app-debug.apk" ;;
  release) APK="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk" ;;
  *)
    echo "지원하지 않는 Android 설치 종류입니다: $VARIANT" >&2
    exit 1
    ;;
esac

if command -v adb >/dev/null 2>&1; then
  ADB="$(command -v adb)"
elif [[ -x "$ADB_DEFAULT" ]]; then
  ADB="$ADB_DEFAULT"
else
  echo "adb를 찾지 못했습니다. Android SDK Platform-Tools를 확인해 주세요." >&2
  exit 1
fi

if [[ ! -f "$APK" ]]; then
  echo "설치할 APK가 없습니다. 먼저 npm run android:build를 실행해 주세요." >&2
  exit 1
fi

DEVICE_COUNT="$($ADB devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')"
if [[ "$DEVICE_COUNT" -ne 1 ]]; then
  echo "USB 디버깅이 허용된 Android 기기 1대가 필요합니다. 현재: ${DEVICE_COUNT}대" >&2
  exit 1
fi

"$ADB" install -r "$APK"

echo "Android 앱 설치 완료. 실제 기기 테스트 때만 USB가 필요합니다."
