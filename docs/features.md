# j-talk 기능 목록

j-talk이 제공해야 하는 기능 목록이다. 근거는 [`decisions.md`](decisions.md)의 결정 번호와 제품군 공통 결정(`j-groupware/docs/architecture.md`의 S 번호)이고, 담당 Item은 PMT 통합 project 분류 `j-talk`이다. 모두 구현 전이다.

손님 화면은 이 저장소의 위젯이, 하위 회원 상담 화면은 j-groupware "상담" 메뉴(GW-35·36)가 그린다.

작성일: 2026-10-07

상세 동작·입출력·실패 처리·인수 시험은 [기능 명세](feature-specifications.md)를 따른다.

## 1. 손님 위젯 (`apps/widget`)

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| TK-01 | 위젯 배포 파일 | CSS를 넣어 압축한 `widget.min.js` 한 파일, 고정 주소 `/ext/talk/v1/widget.min.js`, 짧은 캐시 + ETag, 압축 후 30KB 이하 | 결정 4, S7 | T6 |
| TK-02 | FAB·대화창 | Shadow DOM 안에 오른쪽 아래 버튼, 누르면 대화창(메시지 목록·입력) | 결정 4 | T6 |
| TK-03 | 표시 조건 | j-talk 동작·출처 허용·가입 중 하나라도 아니면 버튼 미표시 | 결정 4 | T6 |
| TK-04 | 방문자 토큰 보관 | localStorage 보관, `Authorization` 헤더 전송 | 결정 2 | T6 |
| TK-05 | 손님 구분자 전달 | `data-guest-id`·`data-guest-exp`·`data-guest-sig` 읽어 전송 | 결정 2, S7 | T6 |
| TK-06 | 실시간 수신·재연결 | WSS 수신, 끊기면 cursor로 재동기화 | 결정 6 | T6 |
| TK-07 | 제한 안내 | 429면 잠시 후 다시 보내라는 안내 | 결정 8 | T6 |
| TK-08 | 삽입 예제 페이지 | 한 줄 스니펫, 서명 구분자 예제 | 결정 4 | T6 |

## 2. 손님 API·WSS (`/ext/talk/`)

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| TK-10 | 방문자 토큰 발급 | 불투명 랜덤 토큰, 해시 저장, 서버 회수 가능 | 결정 2 | T4 |
| TK-11 | 손님 구분자 검증·연결 | HMAC-SHA256(위젯 비밀키, `tenant\|guestId\|exp`) 상수 시간 비교, 만료 검사, 맞으면 손님 id에 문의방 연결, 틀리면 익명 | 결정 2 | T4·T5 |
| TK-12 | 문의 메시지 보내기·받기 | 손님 메시지 → 대기 문의방(없으면 생성), 종료된 방이면 새 방, 답장 수신 | 결정 5 | T5 |
| TK-13 | 출처 검사 | CORS·WSS Origin을 허용 출처 목록으로 검사, 미등록 거절 | 결정 3 | T4 |
| TK-14 | 남용 제한 | 토큰 발급 IP당 분당 10, 메시지 방문자당 분당 20·4KB, 열린 방 1개, 텍스트만 | 결정 8, S6 | T5 |

## 3. 상담 API·WSS (내부, j-groupware 중계)

호출: j-groupware 서버, 사용자 Bearer(aud `j-talk`).

| ID | 기능 | 핵심 동작 | 권한 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| TK-20 | 문의방 목록·조회 | 상태별(대기·진행·종료) 목록, 대화 내용, 손님 구분자 | `talk:read` | 결정 5·7 | T5 |
| TK-21 | 배정·재배정 | 담당 1명 지정 | `talk:write` | 결정 5 | T5 |
| TK-22 | 답장 | 하위 회원 메시지 → 손님 실시간 전달 | `talk:write` | 결정 5 | T5 |
| TK-23 | 종료 | 종료 후 변경 409 | `talk:write` | 결정 5 | T5 |
| TK-24 | 실시간 전달 | 트랜잭션 outbox → 250ms 폴링 → WSS, 서명 cursor + sync 재연결 | `talk:read` | 결정 6 | T5 |
| TK-25 | 허용 출처 관리 | 등록·삭제·목록 | `talk:write` | 결정 3 | T5 |
| TK-26 | 위젯 비밀키 관리 | 발급·교체(원문 1회, 직전 키 24시간 병행) | `talk:write` | 결정 2 | T5 |
| TK-27 | 인증·tenant 격리 | Bearer 검증, 401·403·404·409·429·503, tenant 격리 | - | 결정 7, S8 | T4 |

## 4. 알림

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| TK-30 | 상담 알림 송신 | `talk.new`(role `talk:read`), `talk.assigned`(담당자)를 outbox로 j-groupware 알림 센터에 재시도 송신 | 결정 10, S17 | T9 |

## 5. 기반·운영

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| TK-40 | 저장소 골격·DB | `apps/server`·`apps/widget`·`packages/contracts`, `jgw_talk`·전용 계정 | 결정 9, S2·S11 | T1 |
| TK-41 | contracts | 손님·상담·관리 API, WSS 이벤트·cursor, 토큰·서명 규칙, 상태 모델, 오류 코드, 게시 | 결정 9, S10 | T2 |
| TK-42 | 고객 서버 검증 | 설치·해지(해지 후 빈 위젯 스크립트), `/ext/talk/` 경로, 허용 사이트 위젯 → j-groupware 상담 화면 | S13·S14 | T8 |

## 6. 범위 밖·backlog

첨부 파일, 자동 배정·업무 시간, 문의방 재개·다중 담당, 상담 만족도, 대화 보존 정책, 남용 방지 고도화(캡차·차단 목록), outbox LISTEN/NOTIFY.
