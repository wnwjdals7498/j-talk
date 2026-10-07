# j-talk 설계 결정

j-talk 최소 구현에 필요한 설계 결정을 정리한다. 제품군 공통 기준은 `j-groupware/docs/architecture.md`를 따르고, 이 문서는 그 위에서 j-talk이 정한 내용만 적는다. 각 결정은 PMT project `8802d242-05ee-4538-bb8d-31a6bcb24607`에 같은 번호의 `결정 N` 레코드로 기록되어 있다.

결정일: 2026-10-07

## 0. 범위

- **범위(architecture.md §4, j-groupware 결정 23):**
  - j-messenger 서버 구조(outbox + WSS)를 복제해 줄인다.
  - 손님(고객의 고객)이 삽입형 위젯으로 문의를 남기면, 권한 있는 하위 회원이 전체 문의방을 보고 배정·응대·종료한다.
  - 손님 화면은 삽입형 js·css 위젯이다. j-groupware 결정 22("화면은 j-groupware에서만")의 유일한 예외다.
  - 하위 회원 상담 화면은 j-groupware 메뉴다. j-talk은 API만 만든다.
- **완료 기준:** 위젯으로 보낸 손님 메시지가 j-groupware 상담 목록에 실시간으로 표시되고, 하위 회원이 배정·답장·종료할 수 있다.
- **배치:**
  - 고객 VM(tenant plane) 안에서 동작한다.
  - 손님 위젯·손님 API·WSS는 gateway 예외 경로 `/ext/talk/`로 j-talk 내부 포트에 바로 넘어간다(j-groupware 결정 17·23).
  - 하위 회원 API·WSS는 내부 포트로만 열고 j-groupware 서버가 중계한다.
  - j-talk에 가입한 고객에게만 설치한다(architecture.md 3장 서비스 가입 모델).
- **선행:** j-messenger 서버 구조, j-customer-auth-db 손님 JWT·JWKS(C2·C4), j-auth 서비스 카탈로그(j-auth 결정 25), architecture.md §5 순서 7.

## 1. 손님 식별과 위젯

### 결정 3. 방문자 토큰 형식과 보관
- **결정:**
  - 손님은 익명으로 시작한다. j-talk이 불투명 랜덤 방문자 토큰을 발급한다.
  - DB에는 토큰 해시만 저장한다. 서버에서 회수할 수 있다.
  - 위젯은 고객 사이트의 localStorage에 토큰을 보관하고 `Authorization` 헤더로 보낸다.
  - 수명·회전 규칙은 T2 contracts에서 확정한다.
- **이유:** 위젯은 고객 사이트에서 `gw.<tenant>.jgw.test`로 교차 출처 호출을 하므로 쿠키는 서드파티 쿠키 차단의 영향을 받는다. 불투명 토큰은 서버에서 즉시 회수할 수 있다.

### 결정 4. 손님 로그인 시 대화 연결
- **결정:**
  - 위젯 안에서 j-customer-auth-db 손님 로그인을 하면 j-talk이 손님 JWT를 JWKS로 서명 검증한다(j-customer-auth-db 결정 2).
  - 같은 방문자 토큰의 진행 중 문의방을 그 손님 계정에 연결한다. 이후 대화는 손님 계정 기준으로 이어진다.
- **이유:** 손님이 로그인 전에 남긴 문의가 끊기지 않는다.

### 결정 6. 허용 출처 저장 위치
- **결정:**
  - 위젯 허용 출처(Origin) 목록은 j-talk DB(`tenant_id` 포함)에 저장한다.
  - j-groupware 상담 설정 화면이 Bearer(`talk:write`)로 j-talk 관리 API를 호출해 등록·삭제한다.
  - j-talk이 CORS와 WSS Origin을 이 목록으로 검사한다. 미등록 출처는 거절한다.
  - j-web 사이트 도메인 자동 등록은 j-web 결정 세션에서 같은 API를 쓰도록 요청한다.
- **이유:** 검사하는 서비스가 데이터를 소유하고, 서비스 간 호출을 j-groupware → 서비스 한 방향으로 유지한다(j-approval 결정 21).

### 결정 7. 위젯 구현 방식
- **결정:**
  - `apps/widget`에 바닐라 TypeScript로 만든다. Shadow DOM 안에 오른쪽 아래 FAB와 대화창을 그린다.
  - Vite library 빌드로 `/ext/talk/v1/widget.js`·`widget.css`를 만든다. 경로에 메이저 버전을 넣고 내용 해시로 캐시를 관리한다.
  - 삽입은 `<script src="https://gw.<tenant>.jgw.test/ext/talk/v1/widget.js" async></script>` 한 줄이다. css는 widget.js가 불러온다.
  - 표시 조건 세 가지(고객이 j-talk에 가입함, 출처가 허용됨, j-talk이 동작 중) 중 하나라도 아니면 버튼을 그리지 않는다.
- **이유:** 고객 사이트에 싣는 크기를 최소로 하고 고객 사이트의 프레임워크·CSS와 충돌하지 않는다.

## 2. 상담과 실시간 전달

### 결정 5. 문의방·배정·상태 모델
- **결정:**
  - 문의방 상태는 대기(미배정) → 진행(담당 1명) → 종료다.
  - `talk:write` 보유자가 배정·재배정·답장·종료한다.
  - 종료된 방에 손님이 다시 메시지를 보내면 새 문의방을 만든다. 종료된 방의 변경 요청은 409다.
- **이유:** 완료 기준(배정·답장·종료)을 가장 단순하게 만족한다. 재개·다중 담당은 backlog다.

### 결정 2. 실시간 전달 구조
- **결정:**
  - j-messenger와 같이 쓰기 트랜잭션 안에서 메시지·dedup·`event_outbox`를 함께 기록한다.
  - commit 후 realtime 모듈이 250ms 간격으로 outbox를 폴링해 WSS로 보낸다.
  - 재연결 복구는 j-messenger의 서명 cursor + sync API를 줄여서 쓴다.
- **이유:** j-messenger 코드를 그대로 옮길 수 있고 연결이 끊겨도 이벤트가 유실되지 않는다. LISTEN/NOTIFY는 지연이 문제가 될 때 backlog로 검토한다.

### 결정 8. 하위 회원 상담 API·실시간 경로
- **결정:**
  - j-groupware 상담 화면은 j-groupware 서버를 통해 j-talk 내부 API(HTTP)와 WSS에 접근한다. j-groupware가 중계하면서 Bearer를 붙인다.
  - j-talk은 j-auth 결정 19 기준(RS256, iss, `azp=j-auth`, aud에 `j-talk`, `tenant` claim, 허용 tenant)으로 토큰을 검증하고 `talk:read`/`talk:write`를 검사한다.
  - 응답 구분: 토큰 무효 401, 권한 없음·출처 불허 403, 없음(다른 tenant 포함) 404, 종료 후 변경 409, j-auth·j-customer-auth-db JWKS 장애 503.
- **이유:** 메신저와 같은 방식(j-groupware 결정 22)이라 브라우저는 `gw.<tenant>`에만 연결한다.

## 3. 인증과 권한

### 결정 1. 기능 권한 이름과 위치
- **결정:**
  - 고객 realm마다 role 전용 client `j-talk`(로그인 흐름 끔)에 기능 role `talk:read`(문의방 목록·조회)와 `talk:write`(배정·답장·종료, 허용 출처 등록)를 둔다(j-auth 결정 16·25).
  - j-talk에 가입한 고객의 `tenant:admin` 묶음과 회원 관리 API 부여 가능 role에 들어간다. 쓰기를 체크하면 읽기를 포함한다(j-groupware G6 규칙).
  - `j-auth` client 고정 audience mapper에 aud `j-talk`을 추가한다(j-auth 결정 19).
- **이유:** board·guest와 같은 read/write 패턴이고 서비스별 role client 방식이라 규칙이 하나로 유지된다.

## 4. 데이터·검증·배포

### 결정 9. 저장소·DB·테스트·배포
- **결정:**
  - j-messenger 골격을 복사해 줄인다(`apps/server`, `apps/widget`, `packages/contracts`). 도구·scripts 버전은 같게 고정한다.
  - 고객 VM PostgreSQL 인스턴스에 database `jgw_talk`과 전용 계정을 둔다. 드라이버는 `pg`, 마이그레이션은 node-pg-migrate SQL 파일, 쿼리는 SQL 직접 작성이다. 모든 테이블에 `tenant_id`를 둔다.
  - Vitest로 실제 j-auth·Keycloak·PostgreSQL·j-customer-auth-db를 대상으로 시나리오를 검증한다. 상담 화면 e2e는 j-groupware에서 한다.
  - 로컬에서 완료한 뒤 고객 VM에서 다시 검증한다.
  - 로컬 HTTPS, 비표준 기본 포트 + 설정 변경, 3001 미사용.
- **이유:** 형제 서비스 공통 규칙(architecture.md §3, j-mail 결정 8·9, j-approval 결정 10·11)과 같다.

## 5. 작업 구성

### 결정 0. PMT 계층과 Item 구성
- PMT 계층은 environment `j-groupware-suite` → repository `j-talk`(`b5a6d043-329f-4291-8a0a-254cda729e0b`) → project `j-talk`(`8802d242-05ee-4538-bb8d-31a6bcb24607`)이다.
- Work W1 "j-talk 최소 구현"(`b3e60f64-dada-4c78-a81a-105ceea003b6`)의 완료 기준은 0장 완료 기준과 같다. 사용자가 제안 구성을 승인했다.
- Item 사이의 순서는 `blocked_by`로 건다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| T1 | 저장소 골격 | workspaces(apps/server, apps/widget, packages/contracts), j-messenger 도구 복사·버전 고정, `jgw_talk` database·전용 계정·마이그레이션, 로컬 HTTPS·비표준 포트, 비밀값은 Git 제외 env | j-auth I4 |
| T2 | contracts | 손님 API·상담 API TypeBox schema·DTO, WSS 이벤트·sync cursor, 방문자 토큰 규칙, 상태 모델, 오류 코드, `npm pack` 가능 | T1 |
| T3 | 변경 요청 | 6장 요청을 j-auth·j-groupware·j-web에 전달하고 등록 확인 | - |
| T4 | 인증·권한 게이트 | j-auth·j-customer-auth-db contracts vendor, 하위 회원 Bearer 검증(aud `j-talk`)·`talk:*`, 방문자 토큰, 손님 JWT 검증·대화 연결, CORS·WSS Origin 검사, 허용 tenant, 401·403·404·503 구분 | T2, T3, j-auth I2·I4, j-customer-auth-db C4 |
| T5 | 상담 엔진 | 문의방·메시지·방문자·허용 출처·outbox 테이블(tenant_id), 손님 메시지 → 대기 문의방, 배정·답장·종료, outbox 폴링 → WSS, 허용 출처 관리 API, tenant 격리 테스트 | T4 |
| T6 | 위젯 | widget.js·css 빌드·해시 캐시, Shadow DOM FAB·대화창, 표시 3조건, 방문자 토큰 보관·전송·실시간 수신·재연결, 손님 로그인, 삽입 예제 페이지 | T5 |
| T7 | 완료 기준 테스트 | 실제 의존성 Vitest: 위젯 API 메시지 → 하위 회원 WSS·목록 실시간 표시, 배정·답장·종료, 401·403, 미등록 출처 거절, 손님 로그인 연결, tenant 격리, 장애 503 | T5, T6 |
| T8 | 고객 VM 검증 | VM에서 systemd·`jgw_talk` 마이그레이션·내부 포트, gateway `/ext/talk/` 예외 경로, 허용 출처 사이트 위젯 → j-groupware 상담 화면 배정·답장·종료, VM 대상 T7 통과 | T7, j-groupware G10·G18·상담 화면 |

PMT Item ID: T1 `9277ca53-c2b7-467e-9fa5-29d89069e89b`, T2 `1497230f-8bb1-41d4-8e08-42ed28e292bf`, T3 `f2144257-1ddd-4233-b014-903ce2a8c6f1`, T4 `1b46ec23-e6ec-4576-b001-012ed2d7393b`, T5 `deaeb4af-d098-4f34-9d23-13f5602fe573`, T6 `c8725be8-7388-4211-8c1f-9d39418e2fe9`, T7 `737e0511-190e-41cd-978d-444d1970c4a6`, T8 `3a1aa70e-adc6-47bb-bd48-2bb1ca1c95bc`.

T8의 j-groupware G18·상담 화면 Item은 PMT에 아직 없어 `blocked_by`에 넣지 않았다. 등록되면 추가한다.

backlog: 첨부 파일, 상담 알림(j-mail·메신저), 자동 배정·업무 시간, 문의방 재개·다중 담당, 상담 만족도, 대화 보존 정책, 방문자 남용 방지 고도화, outbox LISTEN/NOTIFY, OIDC 전환.

## 6. 다른 서비스에 넘길 변경 요청

2026-10-07 사용자 지시로 각 대상 프로젝트 PMT에 backlog 레코드로 등록했다. 반영 확인 후 T3을 완료한다.

| 번호 | 대상 | 요청 | PMT 레코드 |
| --- | --- | --- | --- |
| R1 | j-auth | 서비스 카탈로그(결정 25)에 j-talk 추가. 고객 realm에 role 전용 client `j-talk`과 `talk:read`·`talk:write`, `tenant:admin` 묶음 포함, `j-auth` client scope mapping 추가 | `4866ca80-b6a4-4973-a4e4-a6dfbd1cd3c2` |
| R2 | j-auth | `j-auth` client audience mapper와 contracts aud 상수에 `j-talk` 추가 | `c099a27c-f0bf-41d1-abaf-0a078d9867c3` |
| R3 | j-auth | 회원 관리 API 부여 가능 role에 `talk:read`·`talk:write`, 테스트 계정(talk 권한 보유·`talk:read`만 보유·미보유 하위 회원) | `ed291fc1-05d2-4349-b31a-27d9f0bb583a` |
| R4 | j-groupware | 상담 메뉴(`talk:read`, 전체 문의방·배정·답장·종료)와 상담 설정(허용 출처 등록, 설치 안내 스니펫), j-talk HTTP·WSS 중계 + Bearer, 회원 관리 화면에서 두 권한 부여, 권한 표 항목 | `6d0b7262-151c-4966-a6ed-ea5c5e6d80cf` |
| R5 | j-groupware | `gw.conf.template`의 `/ext/talk/` → j-talk 내부 포트 예외 경로 반영 확인, 내부 포트 값 전달 | `ce3a8454-ba66-430d-82f7-52cebdab337b` |
| R6 | j-web | j-talk 동시 가입 시 템플릿 배포에 스니펫 자동 삽입, 사이트 도메인을 j-talk 허용 출처 API로 자동 등록 | `c7161421-3b0b-46be-95cd-36fb9d0d48f1` |
