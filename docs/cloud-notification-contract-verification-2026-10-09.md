# 22차 회원 계약·발생 사건 알림

확정된 회원/settings HTTP DTO·입력 schema를 `@j-talk/contracts@0.1.0`으로
최초 immutable 게시했다. 기존 registry metadata404를 확인했고 기존 버전을
덮어쓰지 않았다. 서버와 Groupware BFF가 같은 schema와 exact lock을 소비한다.
방문자 token·브라우저 WSS·signed sync cursor는 게시 계약에 추가하지 않았다.

`003-notifications.sql`은 기존 event_outbox를 확장한다. 실제 rooms INSERT의
AFTER trigger가 같은 트랜잭션에서 talk.new 발생 UUID를 기록한다. 기존 자기
배정 API도 배정과 talk.assigned/당시 담당자를 함께 commit하고 occurrenceId를
반환한다. 송신 재시도는 roomId:occurrenceId를 유지하고 별개의 배정은 다른
UUID다. assignment HTTP 요청 자체의 client retry idempotency는 제공하지 않는다.

NotificationSender는 기존 G22 loopback 수신 API로 new의 talk:read role 대상과
assigned의 회원 대상을 송신한다. SKIP LOCKED·20초 lease·lease token ACK,
5초 HTTP 제한·1KiB receipt 검증·지수 backoff·shutdown을 연결했다. main은
외부 JT_NOTIFICATION_URL/KEY가 모두 있을 때만 sender를 시작한다. 없으면
활성화하지 않고 부분/외부/예약 포트 입력은 거절한다. 키 공급/운영 갱신이나
systemd timer는 등록하지 않는다. message/WSS 사건은 이 sender가 소비하지 않는다.

Node22.18/24.19 각각 check(build/type/unit2/lint/format), 기존 실제 auth/PG
integration14와 registry fresh consumer1이 exit0이다. 실제 Groupware G22 연결
6개도 두 버전 exit0이다: role별 목록/SSE, 두 실제 자기 배정의 원래 담당자,
room/assignment rollback, 수신 서버 실제 중단, ACK DB 실패, 두 sender lease와
다른 tenant/message 제외, compiled main 강제 종료 후 실제20초 lease 만료 복구.
마지막5초 제한은 전체 수신 SLA나 WSS 전달 완료를 뜻하지 않는다.

새 방은 공개 visitor API가 아니라 실제 PG INSERT로 준비하고 production trigger를
검증했다. T2 방문자 producer·임의 회원 배정·WSS·정식 UI·VM 인수 완료를 주장하지
않는다. 임의 회원 배정의 동일 tenant 검증에는 j-auth 회원 조회에 대한
권한과 BFF→Talk의 신뢰 가능한 대상 전달 계약이 필요하다. 현재 j-auth profile은
member:manage/org:manage만 허용하고 Talk→다른 서비스 직접 호출은 기존 S7에
맞지 않는다. talk:write에 회원 관리 권한을 임의 추가하지 않았다.

로그와 종료 코드는 `/workspace/.suite-runtime/j-groupware/talk22-*.log/.exit`다.
최종 G22는 `talk22-notifications-final-node{22,24}`, Talk check/integration/registry는
`talk22-{check,integration,registry}-node{22,24}`다. 초기 check의 unused UUID lint
실패는 고친 뒤 보존했으며 최종 exit0으로 덮지 않았다. 전체 제품군 인수는 미완료다.
