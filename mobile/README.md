# Mobile WebView shell

Next.js 웹앱을 표시하고, 웹에서 직접 할 수 없는 BLE 작업만 Expo 네이티브 코드가 담당한다.

## 현재 구현 범위

- 허용된 웹앱 origin만 WebView 안에 유지하고 외부 URL·사용자 정의 스킴은 거부
- WebView ↔ Native 메시지 런타임 검증과 크기 제한
- BLE 권한 상태와 등록 후보 검색
- ESP32 provisioning service UUID 기반 후보 필터
- 요청별 `requestId`·등록별 `attemptId` 대조
- Wi-Fi 비밀번호를 서버·Web 저장소·Git·로그에 남기지 않는 원칙. 기기는 재접속을 위해 ESP-IDF 기본 NVS/Flash에 Wi-Fi 설정 저장
- Espressif 공식 Android `lib-2.4.4` 기반 Security 2 연결과 `custom-data` ping→pong 네이티브 모듈
- Android 네이티브 QR 화면에서 등록 정보를 읽고 선택된 BLE 기기와 Security 2 세션 연결
- 실제 Android↔ESP32에서 광고 발견, QR 기기 이름 확인, SRP6a·AES-GCM 세션과 암호화된 ping→pong 왕복
- 같은 Security 2 `ESPDevice` 세션에서 주변 Wi-Fi 이름·신호·보안 여부를 읽어 WebView에 전달하는 `scanWifiNetworks`
- 현재 등록 시도와 선택 기기를 다시 확인한 뒤 같은 Security 2 세션에서 ESP-IDF 표준 Wi-Fi provisioning을 호출하는 `provisionWifi`

## 전용 격리 AWS에서 종단 확인한 것

- Cognito Hosted UI Authorization Code + PKCE 로그인, Refresh token의 SecureStore 보관, Access token의 Native 메모리 보관
- WebView에 토큰을 넘기지 않고 허용된 API 요청만 Native가 대행하는 브리지
- 제품 QR에서만 API `claimId`·`registrationNonce`를 받아 Security 2 세션으로 기기에 결속하는 흐름
- 앱 재시작 뒤 pending Claim 복구와 `ONLINE` 상태 polling
- 기기 목록·제어·예약 API 대행

위 항목은 코드와 자동 테스트가 있으며, 전용 격리 dev에서 Cognito 로그인부터 제품 QR·Security 2·Wi-Fi·Fleet·첫 `state`·제어·예약까지 실제 Android와 ESP32로 확인했다. 잘못된 QR·가짜 기기·변조·재전송·재연결 공격 시험, 소유권 해제 뒤 재등록과 Wi-Fi 실패 경로의 추가 실기기 시험은 남아 있다.

소유권 해제 API 대행과 서버 정리 어댑터는 구현했지만, 단일 시험 기기의 해제 후 재등록 검증 전이라 앱의 해제 버튼은 비활성이다.

화면의 “등록 완료”는 데모 모드에서만 모의 처리한다. 실제 모드에서는 Native의 bootstrap 완료를 최종 성공으로 취급하지 않고, 서버가 첫 runtime `state`를 확인해 `ONLINE`이 된 뒤에만 완료한다.

현재 `react-native-ble-plx`는 후보 검색만 담당하고 GATT 연결을 만들지 않는다. 현재 검색에서 실제로 찾은 기기를 선택하면 스캔 소유권을 놓고, 로컬 Expo Kotlin 모듈이 QR 화면과 GATT·Security 2 세션을 맡는다. QR은 `transport=ble`·`security=2`와 정해진 다섯 필드만 허용하며 원문·사용자명·비밀번호를 WebView, JS 이벤트, 로그에 보내지 않는다. 화면 캡처도 차단한다. 보안 연결 뒤 `scanWifiNetworks`는 같은 `ESPDevice` 세션에서 주변 Wi-Fi 이름·신호·보안 여부를 WebView에 전달한다. `provisionWifi`도 그 세션과 선택 기기가 그대로인지 확인한 뒤 ESP-IDF 표준 설정 호출을 사용한다. Wi-Fi 비밀번호는 서버·브라우저 저장소·로그에 남기지 않고 전송 직후 화면과 브리지 메시지 참조를 비운다.

공식 라이브러리에는 등록 비밀, SoftAP Wi-Fi 자격정보, 주변 SSID와 QR 원문을 Logcat에 출력하는 코드가 있어 로컬 소스에서 해당 로그만 제거했다. 암호·프로토콜 코드는 수정하지 않았다. Gradle 9 호환을 위해 protobuf 빌드 플러그인만 `0.10.0`으로 올렸고 generated protocol과 runtime 버전은 유지했다. 출처와 커밋은 `vendor/esp-idf-provisioning-android/UPSTREAM.md`에 고정했다.

2026-09-04 Android 앱 설치와 실행을 확인했다. 최초 표시된 기기·Wi-Fi 예시는 WebView의 데모 데이터였으므로 실제 BLE 증거에서 제외했다. 이후 가상 데이터가 없는 하드웨어 테스트 모드에서 v5.5.5 Security 2 펌웨어의 실제 광고를 찾고, QR 기기 이름 확인, SRP6a·AES-GCM 세션 수립, 암호화된 `ping → pong`, 같은 세션의 실제 주변 Wi-Fi 목록과 자격정보 전달을 확인했다. 앱 성공 화면뿐 아니라 ESP32 시리얼에서 공유기 접속·IP 할당과 재부팅 후 저장된 설정으로 자동 재접속하는 것까지 확인했다.

첫 Security 2 시도는 ESP-IDF v5.4.1 Python 생성기가 `SHA-512(username:password)` 결과의 맨 앞 `0x00`을 정수 변환에서 잃는 호환성 문제로 실패했다. Android 공식 라이브러리는 64바이트를 유지해 증명이 달라졌고 ATT status 4 쓰기 오류로 끝났다. 생성 단계 guard와 알려진 회귀 검사 2개를 추가하고 새 자격정보·QR·펌웨어로 다시 시험해 성공했다. 실제 비밀값·장치명·MAC·SSID는 기록하지 않았다.

실기기 검증 중에는 네 가지 원인을 고쳤다. Android 12 이상에서 위치정보를 사용하지 않는 BLE Scan 권한을 명시했고, 개발 새로고침 뒤 폐기된 `BleManager`를 재사용하지 않게 했다. 또한 Web 요청 객체 전체를 응답에 펼치면서 요청의 `type`이 `ble.deviceFound` 같은 응답 종류를 덮어쓰던 문제를 수정했다. 마지막으로 네이티브 스캔 시작 Promise가 계속 pending이어도 20초 종료 타이머가 먼저 동작하게 했다. 자동 테스트에는 응답 종류 덮어쓰기와 pending Promise 회귀 사례를 추가했다.

WebView의 `originWhitelist`는 모든 스킴을 콜백으로 넘기도록 설정한다. 허용 목록에 걸린 URL을 라이브러리가 OS에 자동 전달하는 동작을 피하고, `onShouldStartLoadWithRequest`에서 정확한 origin을 검사해 거부하기 위함이다. 배포 빌드는 HTTPS만 허용한다. Android의 최초 로드는 이 콜백을 거치지 않으므로 WebView를 만들기 전에 `EXPO_PUBLIC_WEBAPP_URL`도 검증한다.

독립 APK의 Android `file://` 문서는 opaque origin을 사용한다. 최신 WebView 메시지 경로는 이 값을 문자열 `"null"`로 전달할 수 있어 임베디드 메시지 게이트에서만 허용한다. 화면 이동은 계속 `file:///android_asset/webapp/` 아래로 제한된다. 2026-09-04 Windows에서 수정된 release APK를 개인폰에 설치해 연결 요청이 QR 화면을 여는 것을 확인했다.

## 로컬 검증

```sh
npm ci
npm test
npm run typecheck
npm run android:build
```

Node 테스트 51/51는 실제 TypeScript 코드를 실행하되 BLE 하드웨어 모듈을 대체해 외부 URL 차단, 임베디드 file opaque origin, 열린·보호된 Wi-Fi 비밀번호 계약, 응답 종류 보존, 스캔 제한시간, 검색 콜백 격리, 검색되지 않은·이미 선택한 기기 차단, 이전 시도의 연결 해제 거부, 네이티브 콜백의 세션 결속, QR 비밀의 JS API 비노출, Wi-Fi 목록 재조회, 현재 Security 2 세션·기기에서만 Wi-Fi 전달이 시작되는지를 검사한다. Android QR→Security 2→ping→pong→Wi-Fi 설정·공유기 접속 정상 경로는 v5.5.5 실기기에서 확인했다. 잘못된 QR·변조·재전송 등 부정 시나리오, 실제 WebView 외부 이동과 iOS는 별도 확인해야 한다.

`npm run android:build`는 Android 네이티브 폴더를 준비하고 **Metro 개발 서버용** debug APK를 만든다. **휴대폰과 USB 연결은 필요하지 않다.** 처음에는 네이티브 도구를 내려받고 컴파일하므로 오래 걸릴 수 있지만 이후에는 Gradle 캐시를 재사용한다. 이 Mac에서는 Homebrew OpenJDK 17과 Android SDK를 자동으로 찾도록 했다.

`npm run android:handoff`는 로컬 실기기 시험용 webapp 정적 배포본과 React Native JS를 함께 넣은 release APK를 만든다. 이 APK는 Metro·외부 Web URL·AWS 없이 실행되며 개인 실습용 debug 키로 서명된다. 출력은 `android/app/build/outputs/apk/release/app-release.apk`, 설치는 `npm run android:handoff:install`이다. 상용 배포용으로 사용하지 않는다.

`npm run android:standalone`은 같은 정적 화면을 APK에 넣되 **실제 Cognito 로그인과 API**를 사용한다. 빌드할 때 배포한 AWS의 API·Cognito 환경 변수가 필요하고, 완성된 APK는 Metro·Next.js 서버·`adb reverse`·USB·Amplify 없이 실행한다. 화면·Native 코드·AWS 접속 설정이 바뀌면 다시 빌드해 설치한다.

| 빌드 | AWS 사용 | USB·개발 서버 없이 실행 | 용도 |
|---|---:|---:|---|
| `android:handoff` | 아니요 | 예 | 화면·BLE를 서버 없이 확인 |
| `android:standalone` | 예 | 예 | 전용 격리 AWS 종단 시험 |

이미 만든 APK를 Android 실기기에 설치할 때만 USB 디버깅 연결 후 아래 명령을 사용한다.

```sh
npm run android:install
```

React Native 0.85.3의 Gradle 설정이 Gradle 9와 충돌하는 문제는 설치 후 스크립트가 `foojay-resolver-convention` 1.0.0으로 제한적으로 보정한다. 예상한 원문이 아니면 자동 수정하지 않고 실패한다.


## WebView 실행 모드와 서로 다른 개발 PC 공통 개발 절차

현재 구조는 용도에 따라 세 가지 모드로 운용한다.

| 모드 | WebView 화면 위치 | 웹 화면 수정 뒤 APK 재설치 | 용도 |
|---|---|---:|---|
| Embedded handoff | `file:///android_asset/webapp/index.html` | 필요 | 서버 없이 재현하는 인계·기준본 |
| Embedded standalone | `file:///android_asset/webapp/index.html` | 필요 | 실제 Cognito·API를 쓰는 USB 없는 시험본 |
| 로컬 live 개발 | 개발 PC의 `http://localhost:3210` | 웹 수정만이면 불필요 | 개발 중 화면과 BLE Bridge를 빠르게 확인 |
| Amplify staging/운영 | 고정된 `https://...` origin | 웹 수정만이면 불필요 | 공유 시험과 운영 배포 |

Embedded handoff는 버리지 않는다. 네트워크나 배포 상태와 관계없이 동일한 화면·Native Bridge를 재현하는 기준 APK다. `npm run android:handoff`가 Web의 정적 `out/`을 먼저 만들고 `android/app/src/main/assets/webapp/`에 복사한 다음 React Native JS까지 포함한 release APK를 만든다.

로컬 live 개발은 Android debug 빌드에서만 사용한다. 현재 debug manifest는 cleartext HTTP를 허용하고 `App.tsx`도 `__DEV__`일 때만 HTTP origin을 받아들인다. debug APK는 React Native JS를 넣지 않으므로 Metro `8081`도 필요하다. USB로 연결된 한 대의 Android 기기에는 다음 두 포트를 전달한다.

```text
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3210 tcp:3210
```

- `8081`: debug APK가 React Native JS를 받는 Metro
- `3210`: WebView가 여는 Next.js 개발 서버

Windows PowerShell에서는 다음처럼 실행한다. 첫 터미널은 Web, 둘째 터미널은 Mobile 전용으로 둔다.

```powershell
# 터미널 1
cd webapp
$env:NEXT_PUBLIC_DEMO_MODE = "false"
$env:NEXT_PUBLIC_HARDWARE_TEST_MODE = "true"
npm run dev

# 터미널 2
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3210 tcp:3210
cd mobile
$env:EXPO_PUBLIC_WEBAPP_URL = "http://localhost:3210"
npm run android
```

macOS/Linux에서는 같은 환경 변수를 명령 앞에 둔다.

```sh
# 터미널 1
cd webapp
NEXT_PUBLIC_DEMO_MODE=false NEXT_PUBLIC_HARDWARE_TEST_MODE=true npm run dev

# 터미널 2
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3210 tcp:3210
cd mobile
EXPO_PUBLIC_WEBAPP_URL=http://localhost:3210 npm run android
```

`adb reverse`는 USB 연결이 유지되는 동안 기기의 `localhost`를 현재 개발 PC로 전달하므로 개발 장소가 바뀌어도 IP를 다시 적을 필요가 없다. 네이티브 코드·권한·플러그인이 바뀌면 debug APK를 다시 빌드·설치해야 한다. Web 화면만 바뀌면 Next Fast Refresh가 반영하므로 APK를 다시 설치하지 않는다. 환경 변수를 바꾼 경우에는 Metro를 다시 시작한다.

로컬 HTTPS 인증서를 Android에 배포하는 복잡성은 현재 실기기 개발에 필요하지 않다. 로컬 HTTP는 debug 빌드와 USB 터널에서만 허용한다. release 원격 모드는 `build-android.sh release`와 앱 시작 전 검사 양쪽에서 사용자정보가 없는 HTTPS URL만 허용한다.

Amplify에는 먼저 staging용 고정 HTTPS origin을 만들고 그 주소를 `EXPO_PUBLIC_WEBAPP_URL`에 넣어 원격 release APK를 빌드한다. WebView는 그 정확한 origin만 허용하므로 Amplify 브랜치별 임시 주소보다 환경별 고정 도메인이 적합하다. 웹 배포만 바뀌면 APK 재설치 없이 새 화면을 받을 수 있지만 Native Bridge 계약이나 Android 권한이 바뀌면 새 APK가 필요하다. 실제 Amplify 앱 생성, 배포용 Git 연결, 도메인·Cognito callback·CORS 값 확정은 AWS 계정에서 검토 후 실행한다.

이 로컬 live 절차는 현재 코드와 생성된 debug manifest를 기준으로 성립함을 정적 확인했다. 이번 기록에서는 연결된 휴대폰에서 `adb reverse` 두 포트와 Metro·Next를 동시에 띄우는 실기기 실행은 아직 다시 확인하지 않았다.

## 원격 WebView로 전환하는 메모 (2026-09-05)

현재 handoff APK는 embedded 기준본으로 유지한다. 화면을 실시간으로 수정할 때는 아래 둘 중 하나를 선택한다.

1. 폰을 Mac에 USB로 연결할 수 있으면 Next.js 3210과 Metro 8081을 실행하고 adb reverse를 사용한다. 이 경로는 debug 전용 localhost HTTP이며 로컬 인증서가 필요 없다.
2. 폰을 무선으로 사용하거나 다른 사람과 공유 시험하려면 Mac의 Next.js 서버 앞에 Cloudflare Tunnel 또는 ngrok을 실행해 임시 HTTPS origin을 만든다. Mac이 켜져 있기만 해서는 부족하며 Next.js 서버와 터널 프로세스가 모두 실행 중이고 Mac이 잠들지 않아야 한다.

임시 HTTPS 주소를 EXPO_PUBLIC_WEBAPP_URL에 넣을 때는 URL의 사용자정보가 없어야 하고 앱은 그 정확한 origin만 허용한다. 터널 주소가 바뀌면 Native 앱 설정도 달라지므로 APK를 다시 빌드·설치한다. 고정 Amplify staging origin으로 전환한 뒤에는 Web만 배포한 변경은 APK 재설치 없이 반영된다.

배포 담당자는 mobile/App.tsx의 EMBEDDED_WEBAPP·WEBAPP_URL 결정부와 mobile/scripts/build-android.sh의 release URL 검사를 먼저 확인한다. 실제 AWS 값을 추측해 커밋하지 말고, 확정된 staging URL·Cognito callback/logout·API CORS origin을 같은 환경 기준으로 맞춘다.


## 2026-09-05 실제 로그인·API Bridge 추가

현재 코드는 다음 Native 전용 환경 변수를 사용한다.

| 변수 | 값 |
|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | Terraform `api_slice.api_endpoint`의 HTTPS 주소 |
| `EXPO_PUBLIC_COGNITO_CLIENT_ID` | Terraform `api_slice.cognito_app_client` |
| `EXPO_PUBLIC_COGNITO_DOMAIN` | `https://{api_slice.cognito_domain}.auth.{region}.amazoncognito.com` |
| `EXPO_PUBLIC_WEBAPP_URL` | live/원격 모드에서 WebView가 허용할 정확한 origin |

Cognito app client callback은 `openiot-moodlight://auth/callback`이어야 한다. `.env.example`은 형식만 보여주며 실제 값은 Git에 커밋하지 않는다.

Native는 PKCE 로그인과 refresh를 처리하고 `POST /session/bootstrap`으로 Tenant·Pool을 얻는다. WebView에는 로그인 상태와 안전한 식별자만 보내며 Access/Refresh token, 제품 QR registrationCode, 서버 registrationNonce는 보내지 않는다. 허용된 기기 목록·제어·Claim·예약·소유권 해제 요청만 Native가 JWT와 tenantId를 붙여 대행한다.

제품 등록은 제품 QR → Claim 생성 → Security 2 → Wi-Fi → Claim 상태 조회 → finalize로 연결됐고, 실제 ESP32-S3·Android 앱·전용 격리 dev AWS에서 종단 검증했다. Wi-Fi 성공만으로 완료 처리하지 않고, 서버가 `RUNTIME_AUTHORIZED`를 반환한 뒤 첫 runtime `state`로 `ONLINE`이 확인될 때 등록 완료를 표시한다. 로컬 5필드 QR 시험은 `EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=true`를 명시한 하드웨어 시험에서만 허용한다.

현재 자동 검증은 Mobile 51/51과 TypeScript typecheck다. Native 의존성이 바뀌었으므로 기존 설치 앱에는 새 APK를 한 번 설치해야 한다. 이후 Embedded Web 화면 변경도 새 handoff/standalone APK가 필요하고, live/Amplify Web 화면만 바꾸면 APK 재설치는 필요하지 않다.
