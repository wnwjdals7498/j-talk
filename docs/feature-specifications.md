# j-talk 기능 명세

작성일: 2026-10-08. 상태: **전체 인수 시험 미완료**. 소스 구현과 실제 검증 범위는 [제품군 진행표](../../j-groupware/docs/implementation-progress.json)를 따른다. [목록](features.md), [결정](decisions.md), [공통 기준](../../j-groupware/docs/suite-feature-specifications.md)을 따른다. 손님 위젯은 j-talk, 회원 상담 화면은 j-groupware가 소유한다.

## 입력·출력·상태

| 대상 | 최소 계약 |
| --- | --- |
| 방문자 | tenant·불투명 토큰 해시·회수/수명 정보·방문자 id. HTTP는 Authorization 헤더로 보내며 위젯 localStorage는 고객 사이트 출처에 속한다. |
| 손님 구분자 | guestId·exp(유닉스 초)·sig(base64url HMAC-SHA256). 서명 원문은 `tenant\|guestId\|exp`이고 비밀키는 고객 사이트 서버만 사용한다. 없음/무효/만료는 익명이다. |
| 문의방 | tenant·방 id·방문자/손님 연결·담당 회원 id·상태. 대기→배정 후 진행→종료; 열린 방은 방문자당 1개이며 같은 검증 손님의 열린 방 연결 규칙을 적용한다. |
| 메시지·사건 | tenant·방 id·작성 주체·텍스트·중복 식별자·시각, event_outbox·서명 cursor. 입력 성공은 commit된 메시지와 사건을 뜻한다. |
| 허용 출처 | tenant별 정확한 Origin(스킴·호스트·포트). CORS와 손님 WSS Origin 모두 같은 목록을 검사한다. 회원 WSS의 BFF Origin/중계 계약은 T2에서 구별한다. |
| 위젯 키 | tenant별 현재·직전 키와 교체 시각. 원문은 DB에 저장하되 응답은 발급/교체 1회, 직전 키 기본 24시간 병행이다. DB/백업을 비밀값으로 취급한다. |

정상 흐름: 고정 스크립트 로드 → 표시 조건 3개 확인 → 방문자 token → 첫 메시지와 대기 문의방 → outbox/WSS → 회원 배정·답장·종료. 종료 후 손님 새 메시지는 새 방을 만든다. 회원이 종료된 방에 답장/배정하려 하면 409다. 담당자는 1명이지만 처리 권한은 기존 결정대로 `talk:write` 보유자다.

commit 뒤 250ms 간격 outbox 폴링으로 WSS를 전달하고 cursor sync로 연결 단절 중 사건을 복구한다. 방문자 token과 회원 token, 손님 구분자 서명, WSS 연결 인증은 각각 구분한다.

현재 내부 문의방 목록과 상세는 같은 tenant의 방문자 연결에서 `guestId`를
반환한다. 손님 이름은 Talk가 다른 서비스에서 조회하지 않는다. BFF가
`guest:read` 보유 회원에 한해 customer-auth의 기존 UUID 조회 계약으로
`guestName`을 조합한다. 권한이 없으면 조회와 이름 필드가 없고 식별자만
반환한다. 익명/삭제/다른 tenant 손님은 이름 null, 조회 장애나 무효 UUID는
503이다. 목록은 중복 UUID를 합치고 동시 조회 4개와 전체 10초 한도를 둔다.
이 연결 검증의 문의방은 실제 DB fixture로 준비했으며 방문자 발급·실시간
전달·T2 정책·정식 상담 UI 인수를 뜻하지 않는다.

## 기능별 계약

| 기능 ID | PMT Item | 입력·정상 동작·출력 | 권한·실패 경계 | 인수 시험 |
| --- | --- | --- | --- | --- |
| TK-01 | T6 | Vite library→CSS 포함 widget.min.js 1개·고정 v1 주소 | max-age=300·ETag·압축 30KB 이하의 측정 조건 고정 | TK-T01 |
| TK-02 | T6 | script 로드·FAB 클릭→Shadow DOM 대화창 | host CSS와 독립·메시지 텍스트 렌더링 | TK-T01 |
| TK-03 | T6 | 동작/출처/가입 확인→모두 참이면 표시 | 미가입 빈 script·출처 불허/장애면 버튼 없음 | TK-T01 |
| TK-04 | T6 | localStorage token→HTTP Authorization | 회수/만료 token 재발급 정책 T2, 원문 로그 없음 | TK-T02 |
| TK-05 | T6 | data-guest-id/exp/sig→손님 구분자 입력 | 위젯에서 비밀키 생성/보관 안 함 | TK-T02 |
| TK-06 | T6 | WSS 수신·재연결→서명 cursor sync | 단절 중 누락 복구·같은 사건 중복 표시 방지 | TK-T04 |
| TK-07 | T6 | 제한 응답 429→기다린 뒤 다시 보내기 안내 | 보내지 않은 메시지를 성공 표시하지 않음 | TK-T03 |
| TK-08 | T6 | 한 줄 script·서명 속성·서버 서명 예제 페이지 | 정적 사이트는 익명, 공개 예제 비밀값 없음 | TK-T01·TK-T02 |
| TK-10 | T4 | 허용 tenant/출처·발급 요청→랜덤 token·해시 | IP당 분당 10회, token 원문 저장 없음·회수 검사 | TK-T02·TK-T03 |
| TK-11 | T4·T5 | 만료/서명 확인→guestId 방 연결 | 위조/만료는 익명·다른 손님 열린 방 접근 불가 | TK-T02 |
| TK-12 | T5 | visitor 메시지→열린 방/새 방·텍스트 저장 | 종료된 방 직접 변경 없음·방 소유권 검사 | TK-T03 |
| TK-13 | T4 | CORS/WSS Origin→허용 목록 비교 | 미등록 403, 출처 허용만으로 방문자 인증 대체 불가 | TK-T02 |
| TK-14 | T5 | 메시지→분당 20개·최대 4KB·열린 방 1개 검사 | 제한 초과 429·HTML 미수락, 바이트 단위 T2 고정 | TK-T03 |
| TK-20 | T5 | 상태/페이지/방 id→문의방·대화·guestId | talk:read, 같은 tenant 전체·다른 tenant 404 | TK-T03 |
| TK-21 | T5 | 방 id/같은 tenant 활성 talk:write 담당 후보→수동 배정·재배정→진행 | 요청자 현재 talk:write, 최소 id/username 후보, BFF 10초 서명·nonce transaction, 담당 1명·종료된 방 409 | TK-T03 |
| TK-22 | T5 | 회원 답장→메시지/outbox→손님 수신 | talk:write, 현재 방 상태·tenant 검사 | TK-T03·TK-T04 |
| TK-23 | T5 | 종료 요청→종료 상태 | talk:write, 이후 변경 409·새 문의는 새 방 | TK-T03 |
| TK-24 | T5 | outbox→WSS·cursor sync→누락 사건 | talk:read·방 소유/tenant·cursor 서명 범위 검사 | TK-T04 |
| TK-25 | T5 | Origin 등록/삭제/목록→tenant 허용 출처 | talk:write, path 포함 URL/임의 wildcard 규칙 T2 고정 | TK-T02 |
| TK-26 | T5 | 키 발급/교체→원문 1회·현재/직전 키 | talk:write, 24시간 이후 직전 키 서명은 익명 처리 | TK-T02 |
| TK-27 | T4 | 회원 Bearer/visitor 검증→tenant별 접근 | 401·403·404·409·429·503 구별 | TK-T02·TK-T03 |
| TK-30 | T9 | 방 생성/배정→outbox→talk.new/assigned | 발생 사건별 dedupKey·반복 배정 사건 구별 | TK-T05 |
| TK-40 | T1 | server/widget/contracts·jgw_talk·migration | 전용 DB·tenant 필수·비밀키 백업 보호 | TK-T06 |
| TK-41 | T2 | HTTP/WSS/관리·token/서명/cursor 계약 게시 | 브라우저 WSS 인증·수명·회전 미정 관문 | TK-T06 |
| TK-42 | T8 | VM 위젯→상담 화면→설치/해지 | /ext만 외부 노출·해지 후 위젯 200 빈 응답·VM T7 | TK-T06 |

## 인수 시험

| ID | 관찰할 결과 |
| --- | --- |
| TK-T01 | 실제 삽입 페이지·Shadow DOM·FAB/대화, 표시 조건 각각 실패·script/캐시/ETag·압축 크기, 외부 CSS 영향 없음·미가입 빈 script. |
| TK-T02 | 유효/없는/위조/만료 서명·다른 tenant 서명, token 회수·Origin 거절·다른 방 접근 거절, 키 교체 병행 기간·원문 1회, 회원 Bearer와 방문자 token 혼용 거절. |
| TK-T03 | 첫 메시지→대기·배정/재배정·답장·종료·새 방, read 회원 쓰기 403·다른 tenant 404·종료 409, 요청/IP/메시지 크기/열린 방 제한 경계·텍스트 표시. |
| TK-T04 | 실제 WSS·outbox commit/rollback·250ms 폴링, 단절 중 사건 sync·중복 전송, 위조/다른 방 cursor 거절·회원 세션 종료 시 연결 닫힘. 폴링 간격을 전체 수신 SLA로 간주하지 않는다. |
| TK-T05 | 실제 G22에 role 대상 new·담당자 assigned, 같은 사건 재시도 1건·두 번의 실제 배정 각각 알림, 송신 장애 복구·rollback 시 사건 없음. |
| TK-T06 | contracts 설치·migration/접속 격리, VM 예외 경로·화면·위젯·해지·빈 script·실제 T7 재검증. |

## 확정 관문

T2에서 방문자 token 수명·회전·회수, 브라우저 WSS 인증 전송 방식, Origin 정규화, guestId 재연결/여러 방 충돌, 메시지 중복 id·cursor·본문 단위·DTO를 고정한다. HTTP Authorization 규칙을 브라우저 WSS에 그대로 적용할 수 있다고 가정하지 않는다. 이미 다른 손님에 연결된 token을 새 서명만으로 덮어써 이전 대화를 노출하지 않도록 연결 정책을 시험한다.

`dedupKey=방id:사건`의 사건은 종류 문자열이 아니라 실제 발생의 안정된 식별자다. 첨부·자동 배정·재개·다중 담당·보존 정책·캡차·LISTEN/NOTIFY는 이후 범위다.
