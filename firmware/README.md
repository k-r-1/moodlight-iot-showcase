# Firmware

ESP-IDF 기반 ESP32-S3 펌웨어가 들어갈 위치다.

현재 코드는 기본값으로 보드 내장 WS2812 RGB LED를 제어한다. Kconfig에서 출력 드라이버를 바꾸면 GPIO4·5·6에 연결한 공통 음극 외장 RGB 모듈을 LEDC PWM으로 제어한다. 두 출력 모두 같은 시리얼 전원·색상·밝기 명령을 사용한다.

BLE 기기 등록은 ESP-IDF의 `wifi_prov_mgr`와 **Security 2(SRP6a + AES-GCM)** 를 사용한다. 보안 권고 GHSA-9r76-858f-v6jh 때문에 현행 목표를 **ESP-IDF v5.5.5**로 올렸고, 실제 보드와 Android에서 암호화된 `ping → pong`, Wi-Fi 목록·자격정보 전달·공유기 접속을 확인했다. 재부팅 후 저장된 설정으로 자동 재접속하는 것도 시리얼에서 확인했다. Wi-Fi 자격정보나 요청 본문은 애플리케이션 로그에 남기지 않지만, ESP-IDF는 재접속을 위해 설정을 기기 NVS/Flash에 저장하며 현재 저장 암호화는 적용 전이다.

## 개발환경

- 펌웨어 프레임워크: **ESP-IDF**
- 보드 target: `esp32s3`
- Arduino IDE: 사용하지 않아도 됨. 이 프로젝트에서는 ESP-IDF 하나만 사용한다.
- 2026-09-04: Espressif 공식 EIM으로 **ESP-IDF v5.5.5**를 설치하고 `esp32s3` target의 `fullclean`·전체 빌드·실제 보드 업로드·부팅·Security 2·Wi-Fi 설정·재부팅 후 재접속을 통과했다.
- 기존 v5.4.1에서는 실제 보드 업로드·부팅, 내장 RGB, 시리얼 제어와 Android Security 2 `ping → pong`을 확인했다.
- 보드가 보고한 실제 Flash 용량에 맞춰 펌웨어 이미지 설정을 **16MB**로 고정했다. PSRAM 사용 설정은 메모리를 실제로 사용하는 단계에서 별도로 검증한다.

새 터미널에서는 다음처럼 설치된 환경을 선택해 명령을 실행한다.

최초 1회는 보드마다 서로 다른 로컬 프로비저닝 자료를 먼저 만든다. 이 도구는 비밀번호를 인자나 화면에 출력하지 않으며, salt/verifier 헤더와 QR payload를 `firmware/local/`에 권한 `0600`으로 저장한다. QR은 `name`·`username`·`password`·`transport=ble`·`security=2` 다섯 필드만 담는다. `firmware/local/` 전체는 Git에서 제외되며, 파일이 없으면 빌드가 명확히 실패한다. 기존 자료는 자동으로 덮어쓰지 않는다.

ESP-IDF v5.4.1 실기기 시험에서는 Python SRP6a 생성기가 `SHA-512(username:password)` 결과가 `0x00`으로 시작할 때 정수 변환에서 그 바이트를 잃는 호환성 문제를 확인했다. Android 공식 라이브러리는 64바이트를 유지하므로 이런 자격정보는 증명이 일치하지 않았다. 로컬 생성기는 해당 경우를 재생성하며, 알려진 실패·정상 벡터 2개를 회귀 검사한다.

```bash
eim --log-file /private/tmp/moodlight-eim.log run "python3 tools/generate_provisioning_credentials.py" v5.5.5
```

```bash
eim --log-file /private/tmp/moodlight-eim.log run "idf.py fullclean build" v5.5.5
```

실제 제품에서는 이 로컬 생성 방식을 그대로 출고 공정으로 사용하지 않는다. 제조 단계에서 기기별 salt/verifier만 기기에 주입하고, 사용자에게 전달할 username/password QR은 별도로 보호해야 한다. 공용 기본 비밀번호나 fallback 값은 두지 않는다.

`flash`와 `monitor`는 보드의 `COM` 포트가 Mac에 나타난 뒤 정확한 포트를 지정해 실행한다. 2026-09-04에는 실제 연결 포트로 업로드하고 내장 RGB의 빨강→초록→파랑 스모크 테스트와 `moodlight>` 프롬프트를 확인했다. 개인 장치명은 환경마다 바뀔 수 있으므로 문서에 고정하지 않는다.

펌웨어는 보드의 Flash에 저장되므로 USB를 뽑아도 지워지지 않는다. 다만 보드는 전원이 없으면 꺼진다. 개발 중에는 `COM` 포트로 전원·업로드·로그를 함께 쓰고, 단독 동작 시험에서는 컴퓨터 대신 안전한 5V USB 충전기나 보조배터리를 같은 포트에 연결한다. 두 USB 포트나 외부 5V를 동시에 연결하지 않는다.

시리얼 로그를 직접 볼 때는 `firmware/monitor.command`를 Finder에서 더블클릭하거나 터미널에서 아래처럼 실행한다. 연결된 `/dev/cu.usbmodem*` 장치가 정확히 하나일 때만 자동 선택한다. 로그가 바로 나오지 않으면 보드의 `RST` 버튼을 한 번 누른다.

```bash
./monitor.command
```

종료 단축키는 `Ctrl+]`이다.

시리얼 콘솔 명령은 다음과 같다.

```text
led get
led set --power on --red 255 --green 0 --blue 0 --brightness 10
led set --power off
help
```

`red`·`green`·`blue`는 0~255, `brightness`는 0~100이다. 범위를 벗어난 값, 음수, 알 수 없는 옵션과 중복 옵션은 상태를 바꾸지 않고 거부한다. 실제 보드에서 정상 설정·조회·소등과 오류 입력 후 상태 보존을 확인했다.

사진의 44핀 배열, `COM`·`USB` USB-C 두 포트, LED·점퍼 배치는 `YD-ESP32-S3` DevKitC-1 호환 보드와 일치한다. 모듈은 `ESP32-S3-WROOM-1-N16R8`이고, 공식 DevKitC-1 핀표상 GPIO4·5·6은 일반 입출력이다. N16R8의 Octal PSRAM 연결에 쓰이는 GPIO35·36·37은 외부 부품용으로 사용하지 않는다. 동일 레이아웃 보드 자료의 GPIO48 내장 WS2812 RGB를 실제 빨강·초록·파랑 점등으로 확인했다.

## RGB 출력 선택

기본 설정은 지금까지 실기기 검증한 `Onboard WS2812 (GPIO48)`이다. 기존 `sdkconfig`로 빌드해도 이 출력이 유지된다. 외장 모듈을 시험할 때만 다음 메뉴에서 `External common-cathode RGB LED (LEDC PWM)`을 선택한다.

```text
idf.py menuconfig
→ Moodlight firmware
→ RGB LED output
```

외장 출력의 기본 핀은 R=`GPIO4`, G=`GPIO5`, B=`GPIO6`이며 같은 메뉴에서 바꿀 수 있다. 세 핀은 서로 달라야 한다. 공통 음극 모듈이므로 `-`는 GND에 연결하고 PWM duty가 커질수록 해당 색이 밝아진다. 펌웨어는 LEDC를 설정하기 전에 세 GPIO를 출력 LOW로 내려 꺼진 상태에서 시작하며, 5kHz·8비트 PWM을 사용한다. `brightness`는 각 0..255 색 값에 곱해지고 전원이 꺼지면 세 duty 모두 0이 된다.

이 외장 드라이버를 실제 보드에 flash하고 아래 배선으로 빨강·초록·파랑·혼합색·밝기·소등을 확인했다. 다른 보드나 모듈에 다시 연결할 때는 아래 배선과 안전 규칙을 먼저 확인한다.

## 외부 RGB 모듈 배선

사진의 핀 표기는 `B·G·R·-`이고 세 채널 저항의 `151` 표기는 각각 150Ω을 뜻한다. 아래 배선은 `-`가 공통 음극인 모듈을 위한 것이다. 실제 점등 전에는 멀티미터로 극성과 저항을 확인한다. 점퍼선 색은 전기적 의미가 없으므로 아래처럼 프로젝트 규칙으로 사용한다.

| 선 색 | RGB 모듈 | ESP32-S3 보드 | 역할 |
|---|---|---|---|
| 갈색 | `-` | `GND` | 공통 접지 |
| 빨강 | `R` | `GPIO4` | 빨강 채널 PWM |
| 초록 | `G` | `GPIO5` | 초록 채널 PWM |
| 파랑 | `B` | `GPIO6` | 파랑 채널 PWM |
| 노랑·주황 | 연결하지 않음 | 연결하지 않음 | 남는 선은 끝이 닿지 않게 따로 둠 |

보드 방향을 기준으로 핀 수를 세지 않는다. 각 핀 바로 옆 실크의 `4`, `5`, `6`, `GND`를 직접 확인한다. 외부 RGB 모듈은 `B·G·R·-` 네 핀이 서로 다른 브레드보드 연결 묶음에 꽂혀 있어야 한다. 브레드보드 중앙 홈 양쪽과 분리된 전원 레일은 같은 번호처럼 보여도 연결되지 않을 수 있으므로 모르면 continuity로 확인한다.

사진처럼 보드 수핀과 브레드보드를 연결하려면 보통 **암-수 점퍼선**이 필요하다. 암쪽은 ESP32 핀을 감싸고, 수쪽은 브레드보드에 꽂는다. 모듈 수핀과 보드 수핀을 브레드보드 없이 직접 잇는다면 암-암, 보드까지 브레드보드에 꽂아 행끼리 잇는다면 수-수를 쓴다. 받은 선의 끝 모양이 맞지 않으면 억지로 대지 않는다.

안전 규칙:

- `R`·`G`·`B`를 `3V3`나 `5V`에 직접 연결하지 않는다.
- `-`를 `3V3`나 `5V`에 연결하지 않는다.
- 채널별 SMD 각인 `151`은 표기상 150Ω이다. 실물 이상 여부가 의심되면 저항 양단을 측정한다.
- `-`가 공통 음극인지 멀티미터 diode 모드에서 양방향을 비교해 확인한다. 청·녹색은 시험전압이 낮으면 안 켜질 수 있으므로 무점등만으로 판정하지 않는다.
- 최초 점등은 한 색 채널에 보수적인 추가 직렬저항(예: 1kΩ)을 넣고 GPIO를 `LOW`로 초기화한 뒤 짧게 시험한다. 낮은 PWM은 평균 밝기만 낮출 뿐 순간 피크 전류의 보호책이 아니다.
- 점등 중 보드나 모듈이 뜨거워지거나 냄새가 나면 즉시 USB를 분리한다.

## USB 포트

- 먼저 `COM` 포트를 Mac에 연결한다. 이 포트는 프로그램 업로드와 시리얼 로그 확인에 쓰는 USB-to-UART 경로다.
- `USB` 포트는 ESP32-S3의 네이티브 USB 경로다. 첫 점등 단계에서는 혼동을 줄이기 위해 `COM`만 쓴다.
- 충전 전용 케이블은 시리얼 장치가 생기지 않으므로 데이터 통신이 되는 USB-C 케이블을 사용한다.

근거: [Espressif `ESP32-S3-DevKitC-1` 공식 핀표와 하드웨어 안내](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.0.html), [사진과 동일한 레이아웃의 `YD-ESP32-S3` 보드 자료](https://github.com/profharris/YD-ESP32-S3_ESP32-S3-WROOM-1_Dev). 내장 RGB와 공통 음극 외장 RGB 모듈 모두 실제 점등을 확인했다.

## 개발 보드 Wi-Fi 변경

이미 Wi-Fi가 저장된 개발 보드에서는 부팅이 끝난 뒤 `BOOT` 버튼(GPIO0)을 5초 동안 누르고, 초기화 로그가 나온 뒤 버튼을 놓는다. 펌웨어는 ESP-IDF의 `wifi_prov_mgr_reset_provisioning()`으로 Wi-Fi stack의 저장 설정만 지우고 버튼이 놓인 것을 확인한 뒤 재부팅해 BLE 등록 모드로 돌아간다. 전체 NVS를 지우지 않으므로 다른 NVS namespace에 둘 향후 클라우드 소유권·기기 인증서까지 삭제하지 않는다.

GPIO와 누름 시간은 menuconfig의 `Moodlight firmware`에서 바꿀 수 있다. 기본값은 `CONFIG_MOODLIGHT_WIFI_REPROVISION_BUTTON_GPIO=0`, `CONFIG_MOODLIGHT_WIFI_REPROVISION_HOLD_MS=5000`이다. GPIO0은 boot strap 핀이므로 전원 투입·리셋 중에는 누르지 않고 정상 부팅 뒤에만 사용한다. 이 동작은 Wi-Fi 변경용이며 서버 소유권 해제나 기기 양도를 수행하지 않는다.


## MQTT runtime

AWS IoT MQTT runtime은 기본값이 **비활성**이다. 실제 endpoint와 기기 인증서가 없는 일반 로컬 빌드에서는 기존 BLE·Wi-Fi·시리얼·LED 동작만 사용한다. 개인 격리 dev 시험에서는 Git 제외 설정으로 Fleet·MQTT 옵션을 켜 종단 검증했으며, 다른 환경에서는 그 환경의 endpoint·정책·기기별 값을 확인한 뒤에만 활성화한다.

endpoint, Thing 이름, topic base, Root CA, 기기 인증서, private key는 Git에서 제외된 `firmware/local/mqtt_credentials.h`에만 둔다. 다음 도구는 기존 파일을 덮어쓰지 않고 값을 화면에 출력하지 않는다.

```text
python firmware/tools/generate_mqtt_credentials.py \
  --endpoint <iot-endpoint-hostname> \
  --thing-name <thing-name> \
  --topic-base <project>/<env>/tenants/<tenant>/pools/<pool>/<thing-name> \
  --root-ca <root-ca.pem> \
  --client-cert <device-certificate.pem> \
  --private-key <device-private-key.pem>
```

runtime은 TLS 8883으로 Thing 이름과 같은 clientId를 사용하고 자기 `cmd`를 QoS 1로 구독한다. 명령 payload는 아래 필드만 허용하며 `commandId`, 0 이상의 안전한 정수 `commandSequence`, 하나 이상의 상태 필드가 필수다. 중복 키·알 수 없는 키·범위 밖 값·512바이트 초과·분할 payload는 거부한다.

```json
{"commandId":"command-123","commandSequence":1,"power":true,"red":255,"green":120,"blue":20,"brightness":80}
```

성공한 명령은 LED에 적용한 뒤 `commandSequence`·`commandId`·결과 LED 상태를 하나의 NVS 레코드로 commit하고 `state`를 발행한다. 재부팅하면 이 레코드를 검증해 LED 상태를 복원하며 최초 `state`에도 저장된 `commandId`를 담는다. 같은 sequence와 같은 commandId가 QoS 1 재전송으로 도착하면 LED를 다시 적용하지 않고 현재 `state`를 재발행한다. 더 낮은 sequence 또는 같은 sequence의 다른 commandId는 거부한다. wire payload의 `commandId`는 Backend Ingest에서 `appliedCommandId`로 정규화된다.

각 부팅은 SNTP 동기화 뒤 생성한 `bootStartedAtMs`와 128-bit 임의 `bootId`로 구분한다. `stateSequence`, `telemetrySequence`, `eventSequence`는 한 부팅 안에서 각각 증가하며, Backend는 부팅 시각·부팅 ID·스트림 순번을 함께 비교한다. 따라서 NVS 초기화로 진단용 `bootSequence`가 1로 돌아가도 새 부팅을 받을 수 있고, 이전 부팅에서 늦게 도착한 메시지는 새 상태를 덮지 못한다. 시각 동기화에 실패하면 MQTT runtime을 시작하지 않는다.

MQTT 연결 시 현재 `state`를 먼저 보내 등록의 첫 runtime 상태 경로를 열고, 설정 주기마다 `tele`에 uptime·RSSI·펌웨어 버전을 보낸다. `evt`의 `occurredAt` 계약을 지키기 위해 SNTP로 유효한 UTC가 확인된 뒤 `BOOT`를 보내며 잘못된 명령·적용 실패도 가능한 연결 상태에서는 오류 event로 보고한다. payload의 Tenant·Pool·Thing은 기기가 넣지 않고 Topic Rule이 토픽에서 추출한다.

Fleet 구현은 Claim 인증서로 인증서를 생성하고 RegisterThing 응답의 ThingName·`DeviceConfiguration.topicBase`를 엄격히 검증해 인증서·개인키와 함께 전용 NVS에 저장한다. 파티션 구조는 NVS 암호화를 준비했지만 대표 확인에 따라 토이 시험에서는 저장 암호화를 생략했고 기본 빌드는 계속 OFF다. 최초 발급과 같은 부팅에서는 runtime을 시작하지 않으며, 서버가 Runtime 정책 전환을 완료한 뒤 전원을 재시작하면 저장된 기기별 자격정보로 runtime MQTT를 시작한다. 개인 격리 dev에서 실제 AWS endpoint·Fleet·정책 전환·Topic Rule·Ingest·제어·예약까지 실기기 종단 연결을 확인했다.


## 재현 가능한 외장 RGB 빌드

회사나 다른 PC에서도 메뉴를 다시 누르지 않고 같은 외장 출력 설정을 만들려면 새 build 디렉터리와 추적되는 `sdkconfig.external-rgb.defaults`를 사용한다. 공통 `sdkconfig.defaults`를 먼저 읽어 16MB Flash, 파티션, BLE Security 2 설정을 유지하고 외장 프리셋을 나중에 적용한다.

```powershell
idf.py -B build-external -D SDKCONFIG=build-external/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.external-rgb.defaults" set-target esp32s3
idf.py -B build-external -D SDKCONFIG=build-external/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.external-rgb.defaults" build
idf.py -B build-external -D SDKCONFIG=build-external/sdkconfig -p COM8 flash monitor
```

`COM8`은 2026-09-06 이 Windows PC에서 확인한 포트 예시이므로 다른 PC에서는 실제 포트를 다시 확인한다. 프리셋에는 Wi-Fi, QR 비밀, 인증서, AWS endpoint가 없으며 MQTT runtime도 꺼져 있다. 일반 `flash`는 NVS를 지우지 않지만 `erase-flash`는 저장된 Wi-Fi와 기기 데이터를 지우므로 이 시험에 사용하지 않는다.
