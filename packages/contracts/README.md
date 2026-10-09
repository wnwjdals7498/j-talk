# @j-talk/contracts

0.1.0 publishes the established member HTTP and management subset: tenant-scoped
room states/list/detail, UUID pagination, self assignment and its occurrence ID,
plain-text replies (4096 UTF-8 bytes), close, allowed-origin management, one-time
widget keys and the fixed widget/preflight paths. Server and Groupware BFF consume
these schemas and DTOs. A reply remains delivery `pending` while WSS is unimplemented.

Notification occurrences use the existing G22 envelope: `talk.new` targets role
`talk:read`; `talk.assigned` records the member at assignment time. Each persisted
outbox UUID is one occurrence, and the dedup key is `roomId:occurrenceId`. Network
retry keeps that key; two accepted assignment operations have different IDs.
A new-room trigger and an assignment transaction produce occurrences atomically.
This does not make the assignment HTTP operation idempotent across client retries.

Visitor issuance/lifetime/revocation, guest reconnection/room conflict policy,
browser WSS authentication and signed sync cursors are unpublished T2 gates.
Arbitrary-member assignment needs the authoritative same-tenant directory and
its access/handoff contract; no resolver, grant, cross-service database lookup or
long-lived credential is invented. UI and customer VM acceptance remain separate.
