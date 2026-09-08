# Moodlight WebView 화면

화이트보드의 사용자 흐름을 Next.js 정적 웹앱으로 옮긴 화면 뼈대다.

## 들어 있는 화면

- 데모 로그인
- 여러 기기의 온라인·전원·색상·밝기 요약
- 개별 기기 전원·색상·밝기 제어
- 기기 추가: BLE 검색 → 기기 선택 → Wi-Fi 선택 → 등록 진행 → 완료
- 예약 목록

## 현재 경계

- `NEXT_PUBLIC_DEMO_MODE=true`: 가상 기기·가상 Wi-Fi로 UI 흐름만 확인한다.
- 데모 모드에서는 Native가 있어도 BLE 검색·연결 요청을 보내지 않는다. 데모 화면이 실제 기기와 섞이지 않게 한다.
- `NEXT_PUBLIC_DEMO_MODE=false`: 가상 목록과 데모 로그인을 비활성화하고 Native의 Cognito·API 브리지를 사용한다. 실제 AWS 공개 설정을 넣은 모바일 앱과 함께 실행해야 한다.
- `NEXT_PUBLIC_DEMO_MODE=false NEXT_PUBLIC_HARDWARE_TEST_MODE=true`: 로그인·AWS 없이 실제 BLE 검색, QR·Security 2 연결, ESP32의 Wi-Fi 목록 조회와 자격정보 전달을 검증한다. 가상 기기·가상 Wi-Fi를 만들지 않으며 이 플래그를 지정하지 않으면 활성화되지 않는다.
- BLE는 웹 코드가 직접 처리하지 않고 `postToNative()`로 Expo 앱에 요청한다.
- 실제 기기 목록·제어·예약 API와 Claim `ONLINE` polling은 Native Bridge에 연결돼 있다. 로그인 토큰은 WebView가 아니라 Native SecureStore·메모리에서 관리한다. 개인 격리 dev에서는 Fleet Guard를 제한적으로 활성화해 제품 QR 등록부터 첫 `state`·제어·예약까지 실기기로 확인했고, 시험 뒤 Claim 인증서는 다시 비활성화했다.

민감정보는 브라우저 저장소와 로그에 남기지 않는다. Wi-Fi 비밀번호는 입력 상태로만 유지하고 전송 뒤 또는 화면 이탈 시 비운다.

등록 화면 이탈(홈·뒤로·예약 탭 포함) 시 등록 시도와 요청 ID를 폐기한다. 같은 `attemptId`라도 현재 작업의 `requestId`와 맞지 않는 응답은 무시한다. WebView를 새로 로드했을 때 BLE 세션은 복원하지 않지만, Native SecureStore의 안전한 Claim 식별자는 복원해 서버 상태 조회와 finalize를 재개한다.

## 로컬 검증

Node.js 22.14 이상에서 다음을 실행한다. 의존성은 `package-lock.json`으로 고정한다.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
```

`npm test`는 낡은 응답·다른 요청 종류·화면 이탈 후 타이머의 ID 판정을 검증한다. `npm run build` 성공은 BLE 실기기나 AWS 연결 성공을 의미하지 않는다.


## 정적 배포와 WebView 연결

이 프로젝트는 Next.js 16을 사용하지만 `next.config.ts`의 `output: "export"`로 빌드한다. 결과물은 Node 서버나 SSR이 필요한 앱이 아니라 `webapp/out/`의 정적 HTML·JavaScript·CSS다. `images.unoptimized: true`와 `trailingSlash: true`도 정적 호스팅과 Android asset 포함을 위한 설정이다.

같은 Web 코드를 세 위치에서 사용한다.

1. 개발 중에는 `npm run dev`로 `0.0.0.0:3210`에 띄우고, USB Android 기기의 `adb reverse tcp:3210 tcp:3210`을 통해 WebView가 `http://localhost:3210`을 연다.
2. 인계 기준본은 `NEXT_PUBLIC_EMBEDDED_BUILD=true`로 정적 빌드해 APK asset에 포함한다.
3. 공유 시험과 운영은 `npm run build` 결과인 `out/`을 Amplify Hosting의 고정 HTTPS origin에 배포한다.

Amplify는 Next SSR compute 배포가 아니라 정적 Hosting으로 설정한다. 개념상 빌드 단계는 저장소의 `webapp/`에서 `npm ci --ignore-scripts`, `npm run build`를 실행하고 산출물 디렉터리를 `webapp/out`으로 지정한다. `NEXT_PUBLIC_*` 값은 브라우저 번들에 들어가는 공개 설정이므로 비밀값을 넣지 않는다.

첫 배포 대상은 staging이다. 회사 AWS에서 Git 저장소 연결, Amplify 앱·브랜치 생성, 고정 도메인, Cognito callback/logout URL, API CORS origin을 함께 확정한 뒤 실제 값을 주입한다. 이 Windows 작업에서는 회사 AWS/Git 연결이나 실제 URL 생성을 수행하지 않는다.

원격 Web 화면만 수정한 경우 Amplify 재배포 뒤 APK를 다시 만들 필요가 없다. Native Bridge 메시지 형식, BLE 모듈, Android 권한을 바꾸면 Mobile 코드와 APK도 함께 다시 검증한다. Embedded handoff는 원격 장애와 배포 차이를 분리해 재현하기 위한 기준본으로 계속 보존한다.
