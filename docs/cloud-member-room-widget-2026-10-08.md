# 회원 상담 저장·위젯 배포 파일 검증

클라우드 격리 환경에서 Node 22.18.0·24.19.0 각각 실제 인증/PG 통합
14/14, skip 0, runner exit 0을 확인했다. build/typecheck/unit/lint/format
검사도 통과했다. 전체 TK-T01~06, 실제 브라우저·방문자·WSS·VM 인수와는
구분한다. 최초 실행은 위젯 artifact 상대 경로 오류로 13/14·exit 1이었고
수정 후 두 runtime에서 다시 실행했다.

## 실제 구현

`apps/widget`의 Vite 8.3.4 library 빌드는 inline CSS를 포함한 단일
`widget.min.js`를 만든다. 출력 이름은 고정이며 sourcemap/별도 CSS가 없다.
측정은 생성 파일 전체의 Node gzip 기본 압축 결과이고 30×1024 bytes 이하를
검사한다. 이번 파일은 1,199 bytes, gzip 733 bytes다. 정확한 bytes는
빌드 결과를 기준으로 한다. 서버 고정 경로 `/ext/talk/v1/widget.min.js`는
실제 파일을 반환하고 max-age=300, 내용 SHA256 ETag 및 304를 지원한다.
실제 HTTPS에서 파일 bytes와 weak/복수/wildcard validator를 확인했다.

허용 출처 preflight는 `{allowed:true,available:false}`다. Origin 허용은
방문자 인증과 다르다. 실제 visitor/token transport가 연결될 때까지
위젯은 DOM을 만들지 않는다. 빌드된 스크립트의 이 동작도 검사했다.
Shadow DOM FAB/패널 소스는 있지만 실제 채팅 UI/브라우저 인수는 미완료다.
미가입 gateway의 기존 빈 스크립트 경로는 유지된다.

체크섬 migration 002는 tenant 복합 PK/FK의 visitor·room·message·outbox를
추가한다. visitor당 열린 방 하나, 단일 담당자와 상태, 종료 시각, 텍스트
최대 UTF-8 4096 bytes를 DB/서버에서 제한한다. 방문자 발급·guestId 소유권
정책이나 공개 방 생성 API를 추가하지 않았다. 테스트 방은 실제 PG에
명시적으로 seed한 저장 fixture이며 방문자 producer 구현 증거가 아니다.

- `GET /talk/rooms?status=&limit=&after=`: 같은 tenant 전체, talk:read,
  최대 100개, 방 UUID 기준 안정적 keyset 페이지.
- `GET /talk/rooms/:id`: 상태·담당자·손님 참조. 다른 tenant/없는 방은 404.
- `GET /talk/rooms/:id/messages`: talk:read, DB sequence 기준 저장 순서와
  방 안에 속한 UUID cursor. 손님 이름 조회는 j-groupware의 후속 작업이다.
- `POST /talk/rooms/:id/assign-self {}`: talk:write로 인증된 자기 회원 ID만
  사용해 진행 상태로 전환한다. 다른 회원 배정과 배정 알림은 미구현이다.
- `POST /talk/rooms/:id/messages {requestId,text}`: talk:write, 진행 방,
  같은 tenant. 방 row lock 안에서 메시지와 outbox를 함께 commit한다.
  같은 회원/requestId의 같은 본문은 같은 메시지, 다른 본문은 409다.
  응답 delivery는 pending이며 실제 손님 전달을 뜻하지 않는다.
- `POST /talk/rooms/:id/close {}`: talk:write, 원자 종료. 이후 배정·답장·
  반복 종료는 409다. 종료 후 새 방문자 문의 producer는 미구현이다.

실제 Code/PKCE/token exchange·single j-talk audience·read/write/no-role
회원을 사용했다. 다른 tenant 404, read 회원 쓰기 403, body의 회원/tenant
주입 거절, 동시 재시도 dedup, 메시지 순서·UTF-8 경계, 실제 PG trigger로
outbox 쓰기를 실패시킨 rollback, 열린 방/FK 제약과 종료 후 409를 검사했다.
기존 settings 검사도 다시 통과했다. cross-DB 거절은 유효한 password를
명시적으로 전달하고 PG code 42501을 확인한다. migration 변조 검사는
특정 파일 checksum만 변경/복구한다.

## 남은 연결 작업

방문자 token 수명·회전·회수, browser WSS 인증 전달, guestId 재연결과
방 소유권 충돌은 기존 T2 제품 정책 관문이다. 이를 임의로 정하지 않았다.
방 생성/visitor 쓰기, 다른 회원 배정 검증, WSS·signed cursor sync·outbox
전달, 배정/new 알림과 BFF relay는 계속 구현할 기술 작업이다. 회원 HTTP
경로와 위젯 파일 제공만으로 이 범위를 완료로 처리하지 않는다.

`@j-talk/contracts` 0.1.0은 저장소 내 미게시 계약이다. 추가 경로는
widget/rooms다. 완전한 visitor/WSS contract와 registry 게시는 미완료다.
자격은 checkout 밖 mode-600 env에서 읽으며 token·PW·방 본문을 로그에
출력하지 않는다. DB 55044, HTTPS 55045/55049, j-auth fixture 54231을
사용했고 port 3001·회사 노트북·운영 설치/활성화·PR·main 병합은 사용하지 않았다.
