# Changelog

## 0.2.1 — 2026-10-09

Document the implemented visitor/WSS/sync behavior and remaining acceptance
boundaries. Preserve preliminary 0.2.0 immutable; consumers use 0.2.1 exactly.

## 0.2.0 — 2026-10-09

Add short opaque visitor credentials, verified guest issuance, visitor messages,
realtime event and signed cursor sync DTOs. Message senders have exactly one
member or visitor identifier. Preserve earlier immutable member-only versions.

## 0.1.2 — 2026-10-09

Canonical formatted build of the 0.1.1 addition. The earlier registry version is
retained immutable and is not consumed.

## 0.1.1 — 2026-10-09

Add minimal assignee pages and manual assignment request schemas, the internal
trusted envelope, and fixed ten-second proof/key-derivation contract. Existing
member/settings and notification occurrence DTOs remain compatible.

## 0.1.0 — 2026-10-09

First immutable publication of existing member/settings HTTP DTOs and shared
input schemas, bounded UTF-8 reply rules, assignment occurrence receipts and
G22 notification dedup keys. Visitor/WSS/sync policy remains excluded.
