# @j-talk/contracts

0.1.2 publishes the established member HTTP and management subset: tenant-scoped
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
Manual assignment/reassignment uses `POST /api/talk/rooms/:id/assign` with only
`{ memberId }` in the browser. Candidate pages at `GET /api/talk/assignees?cursor`
contain only `{ id, username }` and `nextCursor`; `talk:write` is required.
The BFF calls j-auth's `/auth/talk/assignees` or `/:id` with its member token and
existing tenant service key. j-auth rechecks the caller and target as enabled,
same-tenant members with current effective `talk:write`, without management grants.

The internal `POST /talk/rooms/:id/assign` additionally requires `authorization`:
base64url JSON followed by a dot and a base64url HMAC-SHA256. Fields are exactly
`v:1, tenant, room, member, actor, sid, iat, exp, nonce`. Times are integer epoch
seconds, `exp=iat+10`, and nonce is a UUID. The key is HMAC-SHA256 of UTF-8
`jgw-talk-assignment-v1:<tenant>` using the decoded existing tenant service key;
Talk receives only that derived key as private `JT_ASSIGNMENT_KEY`. No new random
or permanent credential is issued. Talk binds the proof to its verified member
subject/session, consumes the nonce atomically with the room/outbox write and
refuses expired, forged or replayed proofs. It never calls j-auth or its database.
An absent binding fails closed. Closed rooms remain 409. Each accepted operation
records one assignee and a distinct assignment occurrence. Role changes after
validation can race within the ten-second proof lifetime; the next BFF operation
always validates current roles, and local revoked sessions cannot dispatch.
No online requirement, autoassignment, UI or customer VM acceptance is included.
