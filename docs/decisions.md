# j-talk 설계 결정

j-talk만의 설계 결정을 적는다. 제품군 공통 결정은 [`j-groupware/docs/architecture.md`](https://github.com/wnwjdals7498/j-groupware/blob/main/docs/architecture.md)(이하 architecture.md)의 S 번호를 따르고 여기서는 링크만 한다. PMT는 통합 project `j-groupware-suite`의 분류 `j-talk`에 같은 번호로 기록한다(S16).

정리일: 2026-10-07. 통합 정리에서 결정 번호를 다시 매겼다. 이전 번호는 끝의 대응 표를 본다.

## 0. 범위

- **범위:**
  - j-messenger 서버 구조(outbox + WSS)를 줄여 복제한다.
  - 손님은 고객 웹사이트에 삽입한 위젯으로 문의한다(architecture.md S7). 권한 있는 하위 회원은 j-groupware "상담" 메뉴에서 전체 문의방을 보고 배정·응대·종료한다(j-groupware 결정 13).
  - j-talk은 API와 위젯만 만든다.
- **완료 기준:** 위젯으로 보낸 손님 메시지가 j-groupware 상담 목록에 실시간으로 표시되고, 하위 회원이 배정·답장·종료할 수 있다.
- **배치:**
  - 고객 서버의 선택 서비스다.
  - 손님 위젯·손님 API·WSS는 `/ext/talk/` 예외 경로로 연다(S6).
  - 하위 회원 API·WSS는 내부 포트로만 열고 j-groupware가 중계한다.
- **관련 공통 결정:** S2(서비스·DB), S3(권한), S4(토큰 전달), S6(예외 경로·남용 방지), S7(위젯), S8~S14.

## 1. 권한과 손님

### 결정 1. 기능 권한
- **결정:** role client `j-talk`의 `talk:read`(문의방 목록·조회)와 `talk:write`(배정·답장·종료, 허용 출처·위젯 비밀키 관리)를 쓴다. `talk:write`는 `talk:read`를 포함한다(S3 카탈로그).
- **이유:** board·guest와 같은 read/write 패턴이다.

### 결정 2. 손님 식별: 방문자 토큰과 손님 구분자
- **결정:**
  - **방문자 토큰:**
    - 손님은 익명 방문자로 시작한다. j-talk이 불투명 랜덤 방문자 토큰을 발급하고 DB에는 해시만 저장한다. 서버에서 회수할 수 있다.
    - 위젯은 고객 사이트의 localStorage에 토큰을 두고 `Authorization` 헤더로 보낸다.
    - 수명·회전 규칙은 T2 contracts에서 정한다.
  - **손님 구분자 (사용자):**
    - 고객 사이트가 손님을 알면 위젯 속성으로 구분자를 넘긴다.
    - j-talk은 서명을 확인한 뒤 그 방문자의 문의방을 해당 손님(j-customer-auth-db 손님 id) 앞으로 저장한다.
    - 이미 그 손님 앞으로 된 진행 중 문의방이 있으면 거기에 잇는다.
  - **서명 형식 (S7):**
    - 속성은 `data-guest-id`, `data-guest-exp`(유닉스 초), `data-guest-sig`다.
    - `data-guest-sig` = HMAC-SHA256(위젯 비밀키, `tenant|guestId|exp`)을 base64url로 쓴 값이다.
    - j-talk은 만료(`exp`)와 서명을 상수 시간으로 비교한다. 서명이 없거나 틀리거나 만료됐으면 익명으로 처리하고, 위젯에는 오류를 보이지 않는다.
  - **위젯 비밀키:**
    - tenant마다 j-talk DB에 둔다.
    - j-groupware 상담 설정(`talk:write`)에서 발급·교체한다. 원문은 1회만 보여 준다.
    - 교체할 때는 새 키와 직전 키를 일정 시간(기본 24시간) 함께 받는다.
    - 서명을 검증하려면 원문이 필요하므로 원문을 저장한다. 그래서 DB 백업은 비밀값으로 다룬다.
  - j-talk은 j-customer-auth-db를 호출하지 않는다. 손님 이름 표시는 j-groupware가 한다.
- **이유:**
  - 쿠키는 고객 사이트에서 교차 출처로 쓰면 서드파티 쿠키 차단을 받으므로 헤더 토큰을 쓴다.
  - 구분자를 서명 없이 믿으면 누구나 다른 손님의 대화를 열 수 있다.

### 결정 3. 허용 출처
- **결정:**
  - 위젯 허용 출처(Origin) 목록은 j-talk DB(`tenant_id` 포함)에 둔다.
  - j-groupware 상담 설정과 j-web 배포 후 처리(j-groupware 결정 14)가 Bearer(`talk:write`)로 관리 API를 호출해 등록·삭제한다.
  - CORS와 WSS Origin을 이 목록으로 검사하고, 미등록 출처는 거절한다.
- **이유:** 검사하는 서비스가 데이터를 소유하고, 서비스 호출이 j-groupware → 서비스 한 방향이다.

### 결정 4. 위젯 구현과 배포
- **결정:**
  - `apps/widget`에 바닐라 TypeScript로 만든다. Shadow DOM 안에 오른쪽 아래 FAB와 대화창을 그린다.
  - **배포 (사용자):**
    - Vite library 빌드로 CSS를 JS에 넣어 압축한 파일 하나 `widget.min.js`를 만든다. CSS는 Shadow DOM 안에 주입한다.
    - 고정 주소 `/ext/talk/v1/widget.min.js`로 서빙한다. 파일 이름에 해시를 넣지 않고 `Cache-Control: max-age=300`과 ETag를 쓴다. 그래서 새로 배포하면 모든 사이트가 몇 분 안에 최신 위젯을 받는다. 호환이 깨질 때만 `v2` 경로를 새로 연다.
  - 삽입은 `<script src="https://gw.<tenant>.jgw.test/ext/talk/v1/widget.min.js" async></script>` 한 줄이고, 손님 구분자를 넘길 때만 `data-guest-*` 속성을 더한다.
  - 표시 조건(j-talk 동작 중, 출처 허용됨, 가입함) 중 하나라도 아니면 버튼을 그리지 않는다. 미가입 고객 서버에서는 gateway가 같은 주소에 빈 스크립트를 준다(S7).
  - 크기 목표는 압축 후 30KB 이하다.
- **이유:** 고객 사이트에 싣는 파일이 하나이고, 사이트를 다시 배포하지 않아도 항상 최신이다. 고객 사이트의 CSS·프레임워크와 충돌하지 않는다.

## 2. 상담과 실시간 전달

### 결정 5. 문의방·배정·상태 모델
- **결정:**
  - 문의방 상태는 대기(미배정) → 진행(담당 1명) → 종료다.
  - `talk:write` 보유자가 배정·재배정·답장·종료한다.
  - **수동 담당자 선택 (TK-21, 2026-10-09 사용자 승인):** 현재 같은 tenant의 활성 회원 중 effective `talk:write` 보유자만 후보이며 온라인 여부는 조건이 아니다. BFF는 목록과 매 배정에서 j-auth의 전용 `/auth/talk/assignees` API로 요청자·대상 현재 상태를 확인한다. 이 경로는 회원 관리 권한을 부여하지 않고 `id,username`만 반환한다. 브라우저는 `memberId`만 보낸다.
  - **신뢰 전달:** BFF가 기존 tenant 서비스 키에서 용도·tenant를 묶어 파생한 키로 10초 확인서를 서명한다. Talk는 `JT_ASSIGNMENT_KEY`와 검증된 `j-talk` 토큰의 subject/sid로 tenant·방·대상·요청자·만료를 검사하고 nonce를 배정/outbox와 한 transaction에서 소비한다. 재사용은 409, 위조/잘못된 범위는 403이며 설정 누락은 503이다. Talk가 j-auth API나 다른 DB를 조회하지 않는다. 확인 후 권한 변경과 commit 사이에는 최대 10초의 분산 검증 경계가 있으며 다음 BFF 배정은 현재 권한을 다시 검사한다. 기존 본인 배정 BFF도 이 경로를 사용한다. 원래 Talk 본인 배정 API는 검증된 자기 토큰으로만 기존 동작을 유지한다.
  - 설치 어댑터는 봉인된 bootstrap의 기존 서비스 키로 파생값을 준비한다. 신규 영구 비밀값을 발급하지 않으며, 서비스 키 교체 시 BFF와 Talk 파생 binding을 함께 갱신·재기동해야 한다. 종료 방 409, 담당 1명, 처리 권한 `talk:write`는 유지한다.
  - 종료된 방에 손님이 다시 메시지를 보내면 새 문의방을 만든다. 종료된 방을 바꾸려 하면 409다.
- **이유:** 완료 기준을 가장 단순하게 만족한다. 재개·다중 담당은 backlog다.

### 결정 6. 실시간 전달
- **결정:**
  - j-messenger처럼 쓰기 트랜잭션 안에서 메시지·dedup·`event_outbox`를 함께 기록한다.
  - commit 후 250ms 간격으로 outbox를 폴링해 WSS로 보낸다.
  - 재연결 복구는 j-messenger의 서명 cursor + sync API를 줄여서 쓴다.
- **이유:** j-messenger 코드를 옮길 수 있고 연결이 끊겨도 이벤트가 유실되지 않는다. LISTEN/NOTIFY는 backlog다.

### 결정 7. 하위 회원 API·실시간 경로
- **결정:**
  - j-groupware가 내부 HTTP·WSS로 중계하며 Bearer를 붙인다. j-talk은 j-auth 기준으로 검증하고(aud `j-talk`, S4) `talk:read`/`talk:write`를 검사한다.
  - 응답 구분: 401, 403(권한 없음·출처 불허), 404(다른 tenant 포함), 409(종료 후 변경), 429(제한 초과), 503(JWKS 장애).
- **이유:** 메신저와 같은 방식이라 브라우저는 `gw.<tenant>`에만 연결한다.

### 결정 8. 남용 방지
- **결정:**
  - gateway 제한(S6)에 더해 j-talk이 자체 제한을 둔다. 기본값은 설정으로 바꿀 수 있다.
    - 방문자 토큰 발급: IP당 분당 10회
    - 메시지: 방문자당 분당 20개, 1개 최대 4KB
    - 방문자당 동시에 열린 문의방: 1개
  - 초과하면 429이고, 위젯은 잠시 후 다시 보내라는 안내를 보여 준다.
  - HTML은 받지 않고 텍스트로만 저장·표시한다.
- **이유:** 누구나 호출할 수 있는 공개 쓰기 경로라 최소 제한이 필요하다. 고도화(캡차·차단 목록)는 backlog다.

### 결정 10. 알림 송신
- **결정:**
  - j-groupware 알림 센터(S17)에 알림을 보낸다.
    - `talk.new`: role `talk:read` 대상, 새 문의방이 생길 때
    - `talk.assigned`: 담당자에게, 배정될 때
  - 기존 `event_outbox`에 알림 이벤트를 함께 기록하고 송신 루프가 보낸다(재시도, `dedupKey` = `방id:사건`).
- **이유:** 상담 화면을 열어 두지 않은 회원도 새 문의를 안다.

## 3. 데이터·검증·배포

### 결정 9. 저장소·DB·테스트·배포
- **결정:**
  - S11 골격에 `apps/widget`을 더한다(`apps/server`, `apps/widget`, `packages/contracts`). contracts는 레지스트리에 게시한다(S10).
  - 고객 서버 PostgreSQL에 database `jgw_talk`과 전용 계정을 둔다(S2, S9). 모든 테이블에 `tenant_id`를 둔다(S8).
  - Vitest로 실제 j-auth·Keycloak·PostgreSQL을 대상으로 검증한다. talk 권한 회원은 j-auth 회원 관리 API로 만들고 지운다(S12). 위젯 서명은 테스트가 비밀키로 직접 만든다.
  - 상담 화면 e2e는 j-groupware G19에서 한다. 로컬 완료 후 고객 서버 VM에서 다시 검증한다.
- **이유:** 형제 서비스와 같은 규칙이다.

## 4. 작업 구성

PMT 통합 project 분류 `j-talk`. Work "j-talk 최소 구현"의 완료 기준은 0장과 같다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| T1 저장소 골격 | S11 골격 + `apps/widget`, `jgw_talk`·전용 계정·마이그레이션, 로컬 HTTPS·포트, Git 제외 env | j-auth I4, X1 |
| T2 contracts | 손님 API·상담 API·관리 API(허용 출처, 위젯 비밀키) schema·DTO, WSS 이벤트·sync cursor, 방문자 토큰·구분자 서명 규칙, 상태 모델, 오류 코드, 레지스트리 게시 | T1 |
| T4 인증·권한 게이트 | `@j-auth/contracts` 설치, 하위 회원 Bearer 검증·`talk:*`, 방문자 토큰, 구분자 서명 검증(결정 2), CORS·WSS Origin, 허용 tenant, 401·403·404·429·503 | T2, j-auth I2·I4 |
| T5 상담 엔진 | 문의방·메시지·방문자·허용 출처·위젯 비밀키·outbox 테이블(tenant_id), 손님 메시지 → 대기 문의방, 손님 구분자 연결, 배정·답장·종료, outbox → WSS, 관리 API, 결정 8 제한, tenant 격리 테스트 | T4 |
| T6 위젯 | `widget.min.js` 단일 파일(CSS 포함)·고정 주소·짧은 캐시, Shadow DOM FAB·대화창, 표시 3조건, 방문자 토큰·`data-guest-*` 전송, 실시간 수신·재연결, 429 안내, 삽입 예제 페이지 | T5 |
| T7 완료 기준 테스트 | 실제 의존성 Vitest: 위젯 메시지 → 하위 회원 WSS·목록, 배정·답장·종료, 401·403, 미등록 출처 거절, 서명 구분자 연결·위조 서명 익명 처리, 제한 초과 429, tenant 격리, 503 | T5, T6, j-auth I6 |
| T8 고객 서버 검증 | `provision-service`로 설치·해지(해지 후 빈 위젯 스크립트), systemd·내부 포트, `/ext/talk/` 경로, 허용 출처 사이트 위젯 → j-groupware 상담 화면, VM 대상 T7 | T7, j-groupware G10·G18·G19 |
| T9 알림 송신 | 결정 10, 실제 j-groupware 알림 센터 대상 테스트 | T7, j-groupware G22 |
| T3 | 완료(Done): 변경 요청 반영 확인 | - |

backlog: 첨부 파일, 자동 배정·업무 시간, 문의방 재개·다중 담당, 상담 만족도, 대화 보존 정책, 남용 방지 고도화(캡차·차단 목록), outbox LISTEN/NOTIFY.

## 이전 번호 대응

| 새 | 이전 | 새 | 이전 |
| --- | --- | --- | --- |
| 1 | 1 | 6 | 2 |
| 2 | 3, 4 (+손님 구분자 서명) | 7 | 8 |
| 3 | 6 | 8 | 새로 추가 |
| 4 | 7 (min.js 단일 파일) | 9 | 9 |
| - | - | 10 | 새로 추가(알림 송신) |
| 5 | 5 | - | 0 → 4장 작업 구성, 6장 요청은 모두 반영되어 삭제 |
