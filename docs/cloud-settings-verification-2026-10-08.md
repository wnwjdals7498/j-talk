# 상담 설정·회원 인증·DB 기반

실행일 2026-10-08. TK-25·TK-26은 실제 HTTP·Keycloak·PostgreSQL 검증 대상이며, TK-13·TK-27·TK-40은 일부 구현이다. 위젯·방문자 API·WSS·상담방 엔진을 완료로 처리하지 않는다. `@j-talk/contracts` 0.1.0은 이 저장소 안에서 사용하는 관리 기반 계약이며 아직 registry에 게시하지 않았다.

## 구현

tenant는 외부 설정의 허용 고객과 실제 Bearer의 tenant/issuer/azp/aud를 비교해 결정한다. 내부 회원 API는 축소된 j-talk audience 하나와 세션 sid·사용자 이름을 요구한다. cookie·잘못된 서명·다른 tenant·원래 다중 audience token은 401, 설정 관리 권한 talk:write가 없으면 403이다. request URL/body/header/token은 기본 요청 로그에 기록하지 않는다.

`/talk/settings/origins`는 GET 목록(최대 100개, after/next), POST 등록, DELETE 삭제를 제공한다. 등록/삭제 body는 `{origin}`만 받는다. Origin은 URL.origin과 입력이 정확히 일치하는 http/https 스킴·호스트·포트이며 wildcard, path, credentials, query, 대문자/기본 포트 표기의 별칭, 3001은 거절한다. 중복 409, 자기 tenant에 없는 Origin 삭제 404다. `/ext/talk/v1/preflight`의 GET/OPTIONS는 실제 DB 목록으로 출처를 확인하는 읽기 전용 검사다. 이 경로는 방문자 인증이나 메시지 접근 권한을 발급하지 않는다. 실제 visitor HTTP/WSS 연결은 아직 없다.

`/talk/settings/widget-key` GET은 issued/previousValidUntil만, POST `{}`는 새 32-byte 랜덤 base64url 키를 한 번 반환한다. 원문은 서명 검증을 위해 DB에 저장하므로 DB와 백업은 비밀값이다. 하나의 atomic SQL upsert로 현재 키를 직전 키로 옮기고 DB 시각 기준 24시간 병행한다. 연속 교체는 현재/직전 두 키만 남긴다. 서명은 반환된 키 문자열 자체를 UTF-8 HMAC 키로 사용해 `tenant|guestId|exp`를 SHA-256/base64url로 만든다. guestId는 ASCII `[A-Za-z0-9._-]` 1~128자, exp는 안전한 유닉스 정수이며 delimiter/control 문자는 받지 않는다. owner의 verifyGuest는 없거나 무효·만료·다른 tenant 서명을 익명 null로 처리한다. 이 결과를 기존 방문자/방에 연결하는 정책은 구현하지 않았다.

DB는 jgw_talk 전용 non-superuser, 모든 업무 표 tenant_id, parameter query·checksum migration·transaction/advisory lock이다. pg의 유휴 연결 오류를 안전한 고정 메시지로 받아 DB 중단 중 503으로 응답하고 재연결한다. [node-postgres pool 오류 설명](https://node-postgres.com/apis/pool), [transaction 설명](https://node-postgres.com/features/transactions), [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html), [Fastify schema](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

## 실행과 남은 범위

`npm ci --ignore-scripts` → `npm run check`. 실제 검증은 checkout 밖 JT_TEST_ENV/JAUTH_TEST_ENV의 `isolated-cloud` marker가 있어야 `npm run test:integration`을 실행한다. 필요한 JT 설정은 TENANT, DB_HOST/DB_PORT/DB_PASSWORD, PORT, TLS_CERTIFICATE/TLS_KEY이고 KC_PUBLIC_URL은 등록된 HTTPS origin이다. 운영 env에는 j-auth bootstrap/master 자격이 필요하지 않다. main은 loopback HTTPS로 실행한다.

검증은 S12대로 j-auth API로 고유 고객 realm·서비스 가입·write/read/no-role 회원을 만들고 Code/PKCE 후 실제 token exchange를 사용한다. 전용 DB port 55044, test HTTP 55045/55049를 쓴다. 실제 Origin CRUD/페이지/tenant, HMAC 위조/만료/다른 tenant, 교체 deadline·동시 교체, 401/403/404/409/503, migration 변조 탐지·다른 DB 거절, 실제 DB stop/start 후 보존을 검사한다. Node 22.18.0·24.19.0의 최종 결과는 외부 `.suite-runtime/j-talk/settings-node{22,24}-final-results.json`에 기록한다. 최초 DB stop 실행은 assertion 8개가 통과했으나 runner exit 1이어서 성공 증거로 쓰지 않았다. 유휴 pool 오류 처리를 추가하고 exit 0으로 재검증했다.

방문자 수명/회전/회수·WSS 인증 운반·guestId 재연결/다른 손님 충돌은 제품 정책 관문이다. 방/메시지/outbox/cursor DTO와 엔진은 구현자가 계속 정할 기술 작업이다. 회원 저장·권한과 widget 파일의 후속 검증은 [회원 저장·위젯 검증](cloud-member-room-widget-2026-10-08.md)에 기록한다. 전체 T7/VM 인수는 미실행이다.

최종 결과: Node 22.18.0·24.19.0 실제 integration 각각 8/8, skip 0, runner exit 0. `npm run check`의 build·typecheck·unit 1개·lint·format도 통과했다. 형제 BFF 전체 회귀는 최초 새 DB port 충돌을 해결한 뒤 133/133 통과했으며 55044/55045/55049 구성에서 상담 integration을 다시 실행했다.
