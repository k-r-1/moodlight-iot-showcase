# Infrastructure

이 디렉터리는 기본값으로 배포가 꺼지는 Terraform 구성이다. 격리된 dev 접두사에 DynamoDB 7개, Cognito User Pool·HTTP API, API·Ingest·Scheduled Lambda, IoT/Fleet 기반, `state`·`tele`·`evt` Rule, Scheduler, Device Registry와 Fleet Guard를 단계별로 배포했다. 기능 활성값은 Git에서 제외한 로컬 `terraform.tfvars`에만 둔다.

## 현재 범위

- `openiot-{project}-{env}` 이름과 공통 태그
- 변수 형식 검증과 배포 확인 guard
- On-Demand DynamoDB 7개 테이블
- Device의 `tenant-pool-devices-index` (`KEYS_ONLY`)
- DeviceClaim의 `expiresAt` TTL
- 기본 PITR·삭제 보호와 Terraform `prevent_destroy`
- 계산된 이름과 생성된 테이블 ARN 출력
- 기본 비활성인 Cognito User Pool·공개 클라이언트, HTTP API JWT Authorizer, API Lambda와 최소 IAM·30일 로그 보존
- 기본 비활성인 IoT/Fleet 최소 slice: Thing Type, Claim→Bootstrap→Runtime 정책, 제한된 Provisioning Role·Template
- 향후 OTA·운영 묶음용 Thing Group 1개. 현재 Provisioning Template에는 연결하지 않은 예약 리소스
- 기본 비활성인 출고 Device Registry·Fleet 사전 검증 Hook: 일회용 등록코드 예약과 Fleet 요청 결속
- 기본 비활성인 `state`·`tele`·`evt` Topic Rule: 배포된 Ingest Lambda ARN을 확인해야만 plan 가능

Device GSI의 정렬 키 값은 `POOL#{poolId}#DEVICE#{deviceId}`이고 물리 필드명은 `tenantPoolKey`를 사용한다. 백엔드 handler가 이 값을 생성·조회하며 전용 격리 dev의 실제 기기 목록에서 통합 검증했다.

IoT/Fleet는 AWS IoT/Fleet 구성 사례를 검토해 격리 dev에 배포했다. 기본값은 꺼져 있고 `moodlight-demo-*`·`dev` 외에는 guard가 거부한다. 전용 Claim 인증서는 Terraform 밖에서 생성해 정책만 연결했으며 등록 시험 뒤 다시 `INACTIVE`로 닫았다. 실제 Registry seed·Fleet 등록·Runtime 전환·Topic Rule·Ingest·제어·예약을 한 개인 기기로 검증했다. 남은 것은 부정 시나리오, 소유권 해제 후 재등록과 자동 생성된 Fleet 리소스의 정리 검증이다. `iot:RegisterThing`의 정확한 `Resource = "*"` 한 건은 AWS가 리소스 유형을 제공하지 않는 예외이며, 템플릿 전용 신뢰 조건과 나머지 작업의 접두사 제한으로 보완했다.

## 배포 전에 채울 값

`terraform.tfvars.example`을 Git에 올리지 않을 로컬 `terraform.tfvars`로 복사한 뒤 다음 값을 확인한다.

| 변수 | 확인 대상 |
|---|---|
| `project_token` | 배포 전에 확정한 공식 project token. `moodlight`는 아직 제안값 |
| `environment` | 배포 환경 토큰. 현재 의도는 `dev` |
| `aws_region` | 배포 전에 확정한 단일 AWS Region |
| `aws_account_id` | 배포를 허용한 12자리 계정 ID |
| `owner_tag` | 비용·운영 소유자를 나타내는 공통 태그 값 |
| `cognito_callback_urls` | Expo 딥링크/배포 앱의 정확한 callback URL |
| `cognito_logout_urls` | 배포 앱의 정확한 logout URL |
| `additional_tags` | 필수 태그. 공통 태그 이름은 덮어쓸 수 없음 |

callback/logout 값은 `api_slice_enabled = true`일 때 Cognito app client에 사용한다. HTTPS, 로컬 `http://localhost...`, 명시적인 앱 URI 형식을 받고 fragment는 거부한다. CORS는 정확한 HTTPS origin 또는 로컬 `http://localhost`만 허용하며 `*`를 거부한다. 실제 앱 scheme과 배포 origin은 아직 승인 전이다.

## 로컬 확인 순서

### 새 환경·빈 state 검증

아직 아무 리소스도 배포하지 않은 새 작업 디렉터리에서만 배포 플래그를 끈 예제 입력을 사용한다.

```sh
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform plan -refresh=false -var-file=terraform.tfvars
```

기본 비배포 plan에서 새 AWS 리소스가 0개인지 확인한다. provider 설치에는 네트워크가 필요할 수 있지만 리소스 생성 권한은 필요하지 않다.

### 기존 dev stack을 이어서 관리할 때

이미 배포된 stack은 그 배포에 사용한 `terraform.tfstate`와 Git에서 제외한 `terraform.tfvars`로만 이어서 관리한다. 두 파일은 저장소에 포함되지 않으므로 clone만으로 기존 배포를 관리할 수 없다. 기존 state에서 배포 플래그를 끄면 리소스를 없애는 계획이 생길 수 있으므로 **기본값이나 `terraform.tfvars.example`로 기존 stack을 plan하지 않는다.** plan 전 아래 세 가지를 모두 확인한다.

1. 현재 디렉터리에 해당 배포의 `terraform.tfstate`와 그 state에 맞는 `terraform.tfvars`가 함께 있음
2. 계정은 명시한 승인된 계정, 리전은 `ap-northeast-2`, project token은 `moodlight-demo-*`
3. 결과의 모든 대상이 무드등 전용 접두사이고 `Destroy 0`

```sh
terraform plan -out=<git-밖의-plan-경로>
terraform show -json <git-밖의-plan-경로>
```

state와 plan 파일에는 계정 정보가 들어갈 수 있어 Git·외부에 업로드하지 않는다. Remote State가 아직 없으므로 Git clone만 받은 다른 컴퓨터에서는 이 stack을 plan·apply하지 않는다. 다른 컴퓨터에서 관리해야 한다면 배포 전에 확정한 state 인계나 Remote State를 먼저 구성한다.

## 이후 변경·배포 절차

추가 리소스를 만들거나 배포 구성을 바꿀 때는 AWS 공식 문서와 현재 설계를 대조한 뒤 아래 두 값을 함께 확인한다.

```hcl
deployment_values_confirmed = true
deployment_enabled       = true
```

그 다음 승인된 AWS 자격증명으로 `terraform plan -out=...`을 만들고 계정·리전·7개 테이블 이름·GSI·TTL·PITR·삭제 보호를 리뷰한다. 이 저장소에는 자동 `apply` 명령이나 정적 Access Key를 두지 않는다. Cognito/API/IoT/Fleet/Rule/Scheduler를 구현하기 전에는 앱의 종단간 동작이 완성된 것으로 처리하지 않는다.

IoT/Fleet는 `enable_iot_fleet=true`를 별도로 줘야 하며 Topic Rule은 다시 `enable_iot_rules=true`와 같은 계정·서울 리전·무드등 접두사의 Ingest Lambda가 필요하다. 기기 인증서 비활성화·정책 분리·Thing 삭제 권한은 계정 공용 인증서 범위에 닿을 수 있으므로 `enable_device_decommission=false`가 기본이며 별도 승인 전에는 켜지 않는다. 2026-09-04 IoT/Fleet plan 8 Create·0 Update·0 Delete를 적용했고, 이후 전체 plan 0/0/0을 확인했다. `terraform test -filter=tests/iot_contract.tftest.hcl`은 3단 정책 분리, 고유 namespace, Rule 기본 차단, 정책 크기와 `Resource="*"` 예외가 `iot:RegisterThing` 하나뿐임을 mock provider로 검사했다.

출고 등록 보호 기능은 `enable_fleet_registration_guard=false`가 기본이다. 현재 배포에 사용한 Mac의 Git 제외 설정에서는 명시적으로 활성화해 Device Registry와 Fleet 사전 검증 Hook을 격리 dev에 배포했다. 다음 순서로 별도 계획을 검토하고 활성화했다.

1. 무드등 전용 Claim 인증서를 비활성 상태로 준비하고 정확한 ID를 확정
2. `serial + registrationCode` 제품 QR과 비밀 원문을 제외한 Registry seed를 같은 출고 작업에서 생성
3. 보호 기능 계획에서 Registry·Hook·Template 연결·전용 인증서 정책 연결만 생기고 다른 프로젝트 변경·삭제가 0인지 확인한 뒤 적용
4. 생성된 DynamoDB AttributeValue JSON을 `put-item --item file://...` 입력으로 적재하고 건수·해시를 확인
5. 전용 Claim 인증서를 승인된 절차로 활성화
6. 잘못된 코드·다른 serial·다른 Claim 인증서·만료·재사용 거절과 정상 등록을 실기기로 확인
7. 정상 등록 뒤 Bootstrap→Runtime 정책 전환과 재부팅 후 재접속 시험

이 기능을 켤 때는 `enable_iot_fleet=true`, `api_slice_enabled=true`, 정확한 `fleet_claim_certificate_id`가 함께 필요하다. 이때 Claim 정책은 그 ID로 만든 인증서 ARN 한 개에만 연결된다. Device Registry는 삭제 보호·PITR·Terraform `prevent_destroy`를 사용하고, Hook은 무드등 전용 Template·Claim 인증서·clientId·예약 nonce를 모두 대조한다. Registry·Hook과 seed를 준비한 뒤 제한된 시험 시간에만 Claim 인증서를 활성화해 Fleet 등록을 완료하고 곧바로 다시 `INACTIVE`로 전환했다. 현재 비활성 상태는 등록 실패가 아니라 시험 뒤 잠금 상태다.

### 철거 시 Terraform 밖의 대상

- 전용 Claim 인증서 자체와 로컬 개인키: Terraform은 인증서 생성이 아니라 정책 연결만 관리한다. 정책 분리 후 인증서를 비활성·삭제하고 로컬 키를 별도 폐기한다.
- Fleet가 자동 생성한 개별 Thing·기기 인증서와 연결: Fleet 성공 후 Terraform state 밖에 생기므로 기기별 폐기 workflow로 정리한다.
- Device Registry 항목: Terraform이 개별 추적하지 않는 테이블 데이터다. 철거 전에 백업·삭제 여부를 결정한다. 보호를 해제해 테이블 자체를 삭제하면 항목도 함께 삭제된다.

문서나 캡처에는 계정 ID가 든 전체 ARN, 인증서 ID, endpoint, 개인키를 남기지 않는다.

`...-fleet-lamps` Thing Group은 아직 Provisioning Template이나 운영 흐름에 연결하지 않았다. 이후 OTA·운영 대상을 묶을 필요가 생길 때 사용할 예약 리소스이며, 현재 등록된 Thing이 자동으로 들어간다고 해석하지 않는다.

2026-09-04 시험에서는 Terraform v1.15.8과 공식 AWS Provider v6.63.0을 사용했다. 격리 dev 접두사에 DynamoDB 7개, API/Cognito/Lambda 15개, IoT/Fleet 8개를 각각 Create-only 계획으로 배포했다. 세 적용 모두 기존 리소스 변경·삭제는 0건이었고 마지막 전체 plan은 0/0/0이었다. 앱 설정과 일치하는 `openiot-moodlight://auth/callback`·`openiot-moodlight://auth/logout`과 로컬 CORS를 사용했다. 시험에 사용한 state와 환경값은 저장소에서 제외했으며 Remote State는 구성하지 않았다.


## 2026-09-05 애플리케이션 연결 메모

기존 7개 테이블 중 Tenant·Pool·Schedule이 새 Backend 경로에 실제로 연결됐다. API Lambda 환경 변수와 IAM에는 `TABLE_TENANT`, `TABLE_POOL`, `TABLE_SCHEDULE` 접근이 포함된다. 이 변경은 이미 존재하는 테이블을 새로 만든다는 뜻이 아니라 Lambda 코드가 기존 테이블을 쓰도록 연결하는 변경이다.

모바일 PKCE callback은 현재 배포 기록과 같은 `openiot-moodlight://auth/callback`이다. 배포 환경에서는 `terraform output -json api_slice`의 `api_endpoint`, `cognito_app_client`, `cognito_domain`을 로컬 모바일 환경 변수에 옮긴다. domain은 `https://{cognito_domain}.auth.{aws_region}.amazoncognito.com` 형태로 조합한다.

EventBridge Scheduler와 Scheduled Lambda를 전용 격리 dev에 배포했고, 앱에서 만든 예약이 설정한 분 안에 실행되어 외장 RGB와 `state`가 바뀌는 것을 확인했다. Scheduler는 초 단위 정시 실행을 보장하지 않으므로 앱에 분 단위 정밀도를 안내하고, 90초를 넘긴 전달은 `STALE_DELIVERY`로 건너뛴다.
