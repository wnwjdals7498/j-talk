# j-talk

고객의 고객 메시지 수신/채팅방 조작/응대. j-messenger 서버 구조 기반.

Part of the j-groupware suite. See `j-groupware/docs/architecture.md`.

설계 결정: `docs/decisions.md` (PMT project `8802d242-05ee-4538-bb8d-31a6bcb24607`).

허용 출처·위젯 키 관리와 전용 DB·회원 인증 기반을 구현했습니다. `npm run check`, 준비된 cloud fixture의 `npm run test:integration`으로 검사합니다. [구현·검증과 남은 범위](docs/cloud-settings-verification-2026-10-08.md). 방문자·위젯·상담 엔진은 아직 미완료입니다.
