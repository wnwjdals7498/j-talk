# 방문자·위젯·실시간 전달 구현 및 클라우드 검증

범위는 TK-04·05·06·07·08·10·11·12다. 방문자 token, guest 서명 연결, 실제 HTTPS/WSS, PostgreSQL commit/outbox, 브라우저 재연결을 구현했다. 고객 Hyper-V VM TK-42와 제품군 전체 인수는 실행하지 않았다.

## 공개 계약과 데이터 소유

`@j-talk/contracts` 0.2.1을 게시하고 server/widget/BFF가 정확한 버전을 설치했다. migration 005는 tenant별 hash-only credential, rate limit, cursor 서명 키, 방문자 메시지 작성자, outbox sequence를 추가한다. 공개 DB 권한을 부여하지 않는다. 토큰은 32바이트 랜덤 값을 포함한 `jtv_` credential이며 DB에는 SHA-256만 저장한다. 수명은 30분, 회전은 유효 credential을 잠금 아래 회수하고 같은 방문자의 새 토큰을 한 번만 발급한다. 만료·회수 후 익명 재발급은 새 방문자다.

유효한 사이트 HMAC 서명으로 새 credential을 요청하면 tenant/guestId 잠금 아래 최초 방문자의 열린 방을 사용한다. 없음·변조·만료 서명은 익명 처리한다. 이미 발급된 credential에 새 guestId를 덮어쓰지 않는다. 위젯은 서명 속성을 전달할 뿐 비밀키를 생성하거나 보관하지 않는다. 예제는 익명 HTML과 사이트 서버용 서명 함수로 구분한다.

메시지는 UTF-8 4096바이트까지 일반 텍스트로 표시한다. 방문자당 새 메시지 20개/분, 발급 IP 해시당 10개/분을 검사한다. 같은 UUID/본문 재시도는 한 메시지·한 outbox 사건이며 실패 transaction은 둘 다 rollback한다. 종료 방에 대한 새 문의는 새 방이다. tenant별 outbox 삽입 transaction에 잠금을 먼저 잡고 sequence를 매겨 뒤의 commit을 cursor가 먼저 지나가지 않게 했다.

## 연결과 위젯 동작

방문자 HTTP는 Authorization 헤더, WSS는 등록된 정확한 Origin과 5초 이내 첫 인증 frame을 요구한다. URL에는 토큰을 넣지 않는다. WSS의 250ms 폴링은 DB commit 뒤에만 사건을 반환하고 credential·Origin을 다시 검사한다. 재연결 HTTP sync cursor는 HMAC으로 tenant·방문자 또는 회원 subject/sid·위치·5분 만료를 묶으며 페이지는 100개다. 사건 UUID로 중복 표시를 막는다. 64 KiB 전송 대기, 방문자 연결 4개, 프로세스 전체 1000개 한도를 둔다. 회원 현재 권한 회수는 Groupware BFF가 추가로 검사한다.

Shadow DOM FAB·대화창은 출처별 localStorage credential을 다시 쓰며 유효 기간 종료 전에 회전한다. 네트워크 단절 후 HTTP sync/WSS로 누락 답장을 복구한다. 429는 사용자 안내와 입력을 유지하며 보내지 않은 내용을 성공으로 표시하지 않는다. 메시지는 textContent로 표시한다. 360px/1440px 화면을 실제 Chromium에서 확인했다.

## 실행 증거

Node 22.18.0과 24.19.0에서 전체 `npm run check`와 `npm run test:integration`이 각각 종료 코드 0이다. 통합 시험은 4개 파일, 24개 시험이며 기존 회원/설정 15개, 방문자 8개, 실제 Chromium 위젯 1개다. 격리 tenant, 실제 Auth/Keycloak, PostgreSQL, TLS listener, 실제 WSS와 브라우저를 사용했다.

방문자 시험은 hash-only 저장·다른 tenant·Origin 거절, 동시 UUID 중복 제거, 유효/무효 guest 서명, 회전 경쟁과 만료, cursor 변조/범위, 실제 WSS 회수 종료, 동시 transaction commit 순서, rate limit과 outbox 실패 rollback을 확인했다. Chromium은 방문자 발급·실제 메시지 저장·회원 답장 수신·소켓 단절 후 누락 복구·중복 방지·새로고침 credential 재사용을 확인했다. 실패했던 초기 브라우저 matcher·좁은 화면 overflow는 수정 후 재실행했고 실패 로그는 보존했다.

최종 로그는 `/workspace/.suite-runtime/j-groupware/task25-talk-check-final3-node22.log`, `task25-talk-check-final24.log`, `task25-talk-integration-final22.log`, `task25-talk-integration-final24.log`다. 고객 VM, gateway 외부망, 운영 SMTP/알림 설정, 실제 회사 장비 검증은 이 결과에 포함하지 않는다.

의존성은 Fastify 5용 [`@fastify/websocket` 공식 저장소](https://github.com/fastify/fastify-websocket)의 hook 인증과 동기 listener 등록 요구를 따른다. 브라우저 시험은 [Playwright 공식 BrowserType 문서](https://playwright.dev/docs/api/class-browsertype), 예제 및 빌드는 [Vite 공식 JS API](https://vite.dev/guide/api-javascript)를 따른다. 새 런타임 의존성은 websocket 11.3.1/ws 8.22.0이며 브라우저 시험 의존성은 Playwright 1.63.0이다.
