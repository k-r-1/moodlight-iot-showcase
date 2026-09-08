# Backend

소유권, Claim 만료·serial lock, finalize 멱등성, 명령 접수와 실제 상태의 분리를 검증하는 TypeScript 백엔드다. 도메인 코어는 API Gateway와 분리되어 있고, `src/lambda.ts`가 JWT Authorizer와 DynamoDB를 연결한다.

## 실행

```bash
npm ci
npm test
npm run typecheck
npm run build
```

`src/handlers.ts`는 API Gateway에 종속되지 않은 요청 어댑터다. `src/lambda.ts`는 HTTP API JWT Authorizer가 검증한 `requestContext.authorizer.jwt.claims.sub`만 `auth.userId`로 매핑한다. 요청 body나 임의 header의 사용자 ID는 신뢰하지 않으며, 이 경계는 Lambda 어댑터 테스트로 고정했다. 서비스는 그 뒤 Membership과 리소스 소유권을 다시 검사한다.

배포 환경에서 필요한 설정이 빠진 외부 어댑터는 의도적으로 `NOT_CONFIGURED`(503)를 반환한다.

- Claim 시작: 출고 Registry 테이블을 연결했을 때만 일회용 등록 코드를 원자적으로 검증·예약
- finalize: AWS IoT Thing 속성·기기 인증서·출고 원장 결속 검증과 Runtime 정책 전환이 필요
- 기기 제어: AWS IoT Data Plane의 기기별 `cmd` Publish가 필요

출고 Registry 어댑터, Fleet 사전 검증 Hook, Registry·Thing·인증서 검증과 Runtime 정책 전환을 구현했다. 개인 격리 dev에는 API·Ingest·Scheduled Lambda와 `state/tele/evt` Topic Rule을 배포했고, 실제 ESP32의 Fleet 등록·Runtime 전환·첫 `state`·제어·예약까지 확인했다. 설정이 없는 새 환경에서는 계속 `NOT_CONFIGURED`로 닫히며, 위험 권한의 Terraform guard 기본값도 비활성이다.

## 구현한 로컬 계약

| 메서드 | 경로 | 동작 |
|---|---|---|
| GET | `/devices` | Membership 확인 후 사용자의 Tenant 기기 목록 |
| POST | `/device-claims` | Membership·Pool·출고 등록 코드 확인, Registry 예약·Claim·serial lock을 한 트랜잭션으로 생성 |
| GET | `/device-claims/{claimId}` | Claim 소유자·Membership·만료 확인 후 상태 반환 |
| POST | `/device-claims/{claimId}/finalize` | 소유권·만료 확인, 외부 증명 검증 후 Device 결속. 완료 요청은 멱등 반환 |
| PATCH | `/devices/{deviceId}/state` | 소유권 확인 후 `cmd` 접수. Device의 실제 상태는 바꾸지 않음 |

`DynamoRepository`는 `ports.ts`의 저장소 계약을 실제 DynamoDB 명령으로 구현한다. 테이블 이름과 `DynamoDBDocumentClient`를 주입하며, Membership·Device는 `Get`/`Query`, Claim과 serial lock은 조건부 `TransactWrite`, 명령 ID 기록은 조건부 `Update`만 사용한다. 실서비스 `Scan`은 사용하지 않는다.

`InMemoryRepository`는 한 Node.js 프로세스의 테스트용 구현이라 프로세스 간 동시성이나 재시작을 보장하지 않는다. `DynamoRepository`는 Claim item과 `SERIAL#{serialHash}` lock을 한 트랜잭션으로 만들고, finalize 저장 시 Claim 상태·만료·lock 소유·Device 중복을 다시 검사한다. 완료 시 serial lock의 TTL을 제거하고 `deviceId`를 가진 영구 결속으로 승격하므로 serial을 찾기 위한 `Scan`이 필요 없다. 완료 Claim은 원래 만료 시각을 `claimExpiresAt`으로 보존하고 DynamoDB TTL 대상에서는 제외해 finalize 재시도를 멱등 처리한다.

도메인의 `expiresAt`은 API와 테스트에서 읽기 쉬운 ISO 8601 문자열이다. DynamoDB 저장 어댑터에서는 같은 의미의 TTL 속성 `expiresAt`을 반드시 **Number 형 Unix epoch seconds**로 직렬화하고, 읽을 때 ISO 문자열로 복원한다. 문자열을 DynamoDB TTL 속성에 그대로 저장하면 자동 삭제가 동작하지 않는다.

Registration code와 Fleet 전환 어댑터는 전용 환경 변수와 두 guard가 모두 켜진 환경에서만 활성화된다. 개인 격리 dev에서는 Fleet Provisioning·Runtime 전환·IoT Core `cmd` Publish와 `state` 반영을 실기기로 검증했다. 다른 환경은 같은 설정과 검증 없이 완료로 해석하지 않으며 최신 적용 상태는 루트 `README.md`을 기준으로 한다.

## Lambda 실행 계약

`npm run build`는 `src/lambda.ts`와 필요한 AWS SDK 코드를 `dist/index.mjs` 한 파일로 묶는다. Lambda에는 아래 테이블 이름만 환경 변수로 전달한다.

| 환경 변수 | 사용 방식 |
|---|---|
| `TABLE_MEMBERSHIP` | 사용자와 Tenant Membership을 `Get` |
| `TABLE_DEVICE` | 기기 소유권을 `Get`, 목록을 GSI `Query`, 명령 ID를 조건부 `Update` |
| `TABLE_DEVICE_CLAIM` | Claim·serial lock을 조건부 `TransactWrite` |

본문은 최대 64KiB만 받고 JSON·Base64 HTTP API body를 구분한다. 예상하지 못한 오류는 내부 내용을 노출하지 않는 `INTERNAL_ERROR`로 바꾸며, 응답에는 `cache-control: no-store`를 붙인다.


## 2026-09-05 추가 계약

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/session/bootstrap` | 검증된 JWT `sub`에서 개인 Tenant·기본 Pool·Membership을 멱등 준비 |
| POST | `/devices/{deviceId}/release` | 외부 인증서 폐기 확인 뒤 Device·Claim을 REVOKED, 출고 원장을 REISSUE_REQUIRED로 바꾸고 serial lock 해제 |
| GET/POST | `/schedules` | Tenant 예약 목록과 예약 생성 |
| GET/PATCH | `/schedules/{scheduleId}` | 예약 조회와 revision 조건 변경 |
| POST | `/schedules/{scheduleId}/delete|retry|reconcile` | 삭제 동기화·오류 재시도·상태 복구 |

Lambda에는 기존 변수에 `TABLE_TENANT`, `TABLE_POOL`, `TABLE_SCHEDULE`이 추가된다. 개인 격리 dev의 Registry 검증·Fleet 증명·정책 전환·Scheduler·IoT `cmd` Publisher·Ingest는 실제 AWS 어댑터가 연결됐다. 소유권 해제용 인증서 폐기 어댑터도 구현했지만 `해제 → 재등록` 실기기 종단 검증 전이라 앱 버튼은 비활성으로 둔다.

최신 검증 건수와 AWS 적용 상태는 루트 `README.md`을 기준으로 한다.
