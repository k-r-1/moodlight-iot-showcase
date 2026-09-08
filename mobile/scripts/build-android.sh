#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEBAPP_DIR="$(cd "$MOBILE_DIR/../webapp" && pwd)"
ANDROID_SDK_DEFAULT="${HOME}/Library/Android/sdk"
BREW_JAVA_17=""
VARIANT="${1:-debug}"

case "$VARIANT" in
  debug)
    GRADLE_TASK="app:assembleDebug"
    APK="$MOBILE_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
    export EXPO_PUBLIC_EMBEDDED_WEBAPP=false
    export EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=false
    ;;
  release)
    GRADLE_TASK="app:assembleRelease"
    APK="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
    export EXPO_PUBLIC_EMBEDDED_WEBAPP=false
    export EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=false
    node -e 'const raw=process.env.EXPO_PUBLIC_WEBAPP_URL; let url; try { url=new URL(raw); } catch {} if (!url || url.protocol !== "https:" || url.username || url.password) { console.error("독립 APK에는 사용자정보가 없는 HTTPS EXPO_PUBLIC_WEBAPP_URL이 필요합니다."); process.exit(1); }'
    ;;
  handoff)
    GRADLE_TASK="app:assembleRelease"
    APK="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
    export EXPO_PUBLIC_EMBEDDED_WEBAPP=true
    export EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=true
    (
      cd "$WEBAPP_DIR"
      NEXT_PUBLIC_EMBEDDED_BUILD=true NEXT_PUBLIC_DEMO_MODE=false NEXT_PUBLIC_HARDWARE_TEST_MODE=true npm run build
    )
    ;;
  standalone)
    GRADLE_TASK="app:assembleRelease"
    APK="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
    export EXPO_PUBLIC_EMBEDDED_WEBAPP=true
    export EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=false
    node -e 'for (const name of ["EXPO_PUBLIC_API_BASE_URL", "EXPO_PUBLIC_COGNITO_CLIENT_ID", "EXPO_PUBLIC_COGNITO_DOMAIN"]) { if (!process.env[name]?.trim()) { console.error(`독립 AWS APK에는 ${name}이 필요합니다.`); process.exit(1); } } const raw=process.env.EXPO_PUBLIC_COGNITO_DOMAIN.trim(); let url; try { url=new URL(raw); } catch {} if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") || !/\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(url.hostname)) { console.error("EXPO_PUBLIC_COGNITO_DOMAIN에는 https://{prefix}.auth.{region}.amazoncognito.com 전체 주소가 필요합니다."); process.exit(1); }'
    (
      cd "$WEBAPP_DIR"
      NEXT_PUBLIC_EMBEDDED_BUILD=true NEXT_PUBLIC_DEMO_MODE=false NEXT_PUBLIC_HARDWARE_TEST_MODE=false npm run build
    )
    ;;
  *)
    echo "지원하지 않는 Android 빌드 종류입니다: $VARIANT" >&2
    exit 1
    ;;
esac

if command -v brew >/dev/null 2>&1; then
  BREW_JAVA_17="$(brew --prefix openjdk@17 2>/dev/null || true)"
fi

if [[ -n "$BREW_JAVA_17" && -x "$BREW_JAVA_17/bin/java" ]]; then
  export JAVA_HOME="$BREW_JAVA_17"
elif [[ -z "${JAVA_HOME:-}" ]]; then
  if /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
    export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
  else
    echo "Java 17을 찾지 못했습니다. brew install openjdk@17을 실행해 주세요." >&2
    exit 1
  fi
fi

export PATH="$JAVA_HOME/bin:$PATH"

if [[ -z "${ANDROID_HOME:-}" && -d "$ANDROID_SDK_DEFAULT" ]]; then
  export ANDROID_HOME="$ANDROID_SDK_DEFAULT"
fi

if [[ -z "${ANDROID_HOME:-}" || ! -d "$ANDROID_HOME" ]]; then
  echo "Android SDK를 찾지 못했습니다. ANDROID_HOME을 설정해 주세요." >&2
  exit 1
fi

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

cd "$MOBILE_DIR"
node scripts/patch-react-native-gradle.cjs
npx expo prebuild --platform android
if [[ "$VARIANT" == "handoff" || "$VARIANT" == "standalone" ]]; then
  node scripts/embed-webapp.cjs
fi
cd android
if [[ "$GRADLE_TASK" == "app:assembleRelease" ]]; then
  # Expo release bundles bake EXPO_PUBLIC_* values into JavaScript. Gradle does
  # not track those environment variables, so force this task when switching
  # between hosted and embedded builds.
  ./gradlew :app:createBundleReleaseJsAndAssets --rerun-tasks
fi
./gradlew "$GRADLE_TASK"

if [[ "$VARIANT" == "handoff" || "$VARIANT" == "standalone" ]]; then
  BUNDLE_CHECK="$(mktemp)"
  EMBEDDED_INDEX_CHECK="$(mktemp)"
  trap 'rm -f "$BUNDLE_CHECK" "$EMBEDDED_INDEX_CHECK"' EXIT
  unzip -p "$APK" assets/index.android.bundle > "$BUNDLE_CHECK"
  node -e 'const fs=require("node:fs"); const bundle=fs.readFileSync(process.argv[1],"utf8"); if (!bundle.includes("file:///android_asset/webapp/index.html") || bundle.includes("http://localhost:3210")) { console.error("embedded APK does not contain the expected WebView runtime."); process.exit(1); }' "$BUNDLE_CHECK"
  if [[ "$VARIANT" == "standalone" ]]; then
    node -e 'const fs=require("node:fs"); const bundle=fs.readFileSync(process.argv[1],"utf8"); for (const name of ["EXPO_PUBLIC_API_BASE_URL", "EXPO_PUBLIC_COGNITO_CLIENT_ID", "EXPO_PUBLIC_COGNITO_DOMAIN"]) { if (!bundle.includes(process.env[name])) { console.error(`독립 APK에 현재 ${name} 값이 포함되지 않았습니다.`); process.exit(1); } }' "$BUNDLE_CHECK"
  fi
  unzip -p "$APK" assets/webapp/index.html > "$EMBEDDED_INDEX_CHECK"
  if ! cmp -s "$WEBAPP_DIR/out/index.html" "$EMBEDDED_INDEX_CHECK"; then
    echo "embedded APK의 index.html이 최신 Web build와 다릅니다." >&2
    exit 1
  fi
  rm -f "$BUNDLE_CHECK" "$EMBEDDED_INDEX_CHECK"
  trap - EXIT
fi

echo
echo "Android APK 빌드 완료:"
echo "$APK"
echo "이 명령은 휴대폰이나 USB 연결이 필요하지 않습니다."
