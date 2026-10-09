import { describe, it, expect } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { assignmentVerifier } from "../../apps/server/src/assignment.js";

describe("trusted assignment boundary", () => {
  const key = randomBytes(32).toString("base64url"),
    room = randomUUID(),
    member = randomUUID();
  const actor = {
    tenantId: "fixture",
    subject: randomUUID(),
    roles: ["talk:write"],
    claims: { sid: "session-a" },
  };
  const now = Math.floor(Date.now() / 1000);
  const base = {
    v: 1,
    tenant: "fixture",
    room,
    member,
    actor: actor.subject,
    sid: "session-a",
    iat: now,
    exp: now + 10,
    nonce: randomUUID(),
  };
  const sign = (data: Record<string, unknown>, signingKey = key) => {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    return (
      payload +
      "." +
      createHmac("sha256", Buffer.from(signingKey, "base64url"))
        .update(payload)
        .digest("base64url")
    );
  };
  it("binds a genuine short-lived grant to every actor/target dimension", () => {
    const verify = assignmentVerifier("fixture", key);
    expect(verify(sign(base), room, member, actor).nonce).toBe(base.nonce);
    for (const changed of [
      { tenant: "foreign" },
      { room: randomUUID() },
      { member: randomUUID() },
      { actor: randomUUID() },
      { sid: "session-b" },
      { v: 2 },
      { extra: true },
      { nonce: "invalid" },
      { exp: now + 11 },
      { iat: now - 11, exp: now - 1 },
      { iat: now + 5, exp: now + 15 },
    ])
      expect(() =>
        verify(sign({ ...base, ...changed }), room, member, actor),
      ).toThrow();
    expect(() =>
      verify(
        sign(base, randomBytes(32).toString("base64url")),
        room,
        member,
        actor,
      ),
    ).toThrow();
    for (const proof of [
      "forged",
      sign(base) + ".extra",
      sign(base).slice(0, -8),
      "..",
      "e30.AAAA",
    ])
      expect(() => verify(proof, room, member, actor)).toThrow();
  });
  it("fails closed when no trusted binding is configured", () => {
    expect(() =>
      assignmentVerifier("fixture")(sign(base), room, member, actor),
    ).toThrow();
    expect(() => assignmentVerifier("fixture", "bad key")).toThrow();
  });
});
