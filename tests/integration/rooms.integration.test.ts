import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { readFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
describe("actual member room storage and built widget", () => {
  let r: Runtime, id: string, visitor: string;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    token = r.actors[0]!.token,
    port = 55045,
    headers: Record<string, string> = {},
  ) =>
    r.fetch(`https://auth.jgw.test:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  beforeAll(async () => {
    r = await integrationRuntime();
    id = randomUUID();
    visitor = randomUUID();
    const tenant = r.fixtures[0]!.tenant;
    // Actual PG storage seeds only: no visitor issuer, room producer or ownership
    // policy is represented as implemented by this fixture.
    await r.pool.query(
      "INSERT INTO visitors(tenant_id,id,guest_id) VALUES ($1,$2,$3)",
      [tenant, visitor, "signed-guest-fixture"],
    );
    await r.pool.query(
      "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
      [tenant, id, visitor],
    );
  });
  afterAll(async () => {
    await r?.pool.query(
      "DROP TRIGGER IF EXISTS fixture_fail_outbox ON event_outbox",
    );
    await r?.pool.query("DROP FUNCTION IF EXISTS fixture_fail_outbox()");
    await r?.close();
  });
  it("serves the measured single Vite artifact with embedded CSS, fixed v1 cache and ETag 304; unavailable visitor transport displays no widget", async () => {
    const files = await readdir(
      new URL("../../apps/widget/dist/", import.meta.url),
    );
    expect(files).toEqual(["widget.min.js"]);
    const bytes = await readFile(
      new URL("../../apps/widget/dist/widget.min.js", import.meta.url),
    );
    expect(gzipSync(bytes).length).toBeLessThanOrEqual(30 * 1024);
    expect(bytes.toString()).toContain("attachShadow");
    expect(bytes.toString()).toContain(":host");
    const res = await request(
      "/ext/talk/v1/widget.min.js",
      "GET",
      undefined,
      "",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("max-age=300");
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    const etag = res.headers.get("etag")!;
    for (const value of [etag, "W/" + etag, `"old", ${etag}`, "*"]) {
      const cached = await request(
        "/ext/talk/v1/widget.min.js",
        "GET",
        undefined,
        "",
        55045,
        { "If-None-Match": value },
      );
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
    }
    await request("/talk/settings/origins", "POST", {
      origin: "https://widget.example.test",
    });
    const pre = await request(
      "/ext/talk/v1/preflight",
      "GET",
      undefined,
      "",
      55045,
      { Origin: "https://widget.example.test" },
    );
    expect(await pre.json()).toEqual({ allowed: true, available: false });
    let domWrites = 0;
    runInNewContext(bytes.toString(), {
      document: {
        currentScript: {
          src: "https://gw.fixture.jgw.test/ext/talk/v1/widget.min.js",
        },
        createElement: () => {
          domWrites++;
          throw new Error("Unavailable visitor transport must not create DOM");
        },
      },
      URL,
      fetch: async () => ({
        ok: true,
        json: async () => ({ allowed: true, available: false }),
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(domWrites).toBe(0);
  });
  it("reads same-tenant rooms/guest reference using talk:read and masks foreign resources", async () => {
    const res = await request(
      `/talk/rooms/${id}`,
      "GET",
      undefined,
      r.actors[1]!.token,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      status: "waiting",
      guestId: "signed-guest-fixture",
      assignedMemberId: null,
    });
    expect(
      (
        await request(
          "/talk/rooms?status=waiting&limit=1",
          "GET",
          undefined,
          r.actors[1]!.token,
        )
      ).status,
    ).toBe(200);
    for (const path of [`/talk/rooms/${id}`, `/talk/rooms/${id}/messages`])
      expect(
        (await request(path, "GET", undefined, r.foreign, 55049)).status,
      ).toBe(404);
    expect(
      (await request(`/talk/rooms/${id}`, "GET", undefined, r.actors[2]!.token))
        .status,
    ).toBe(403);
    expect(
      (await request(`/talk/rooms/${id}`, "GET", undefined, "")).status,
    ).toBe(401);
    expect(
      (
        await request(
          `/talk/rooms/${id}/assign-self`,
          "POST",
          {},
          r.actors[1]!.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/talk/rooms/${id}/assign-self`,
          "POST",
          {},
          r.foreign,
          55049,
        )
      ).status,
    ).toBe(404);
  });
  it("self-assigns from actual verified member identity; refuses body identity and unassigned replies", async () => {
    expect(
      (
        await request(`/talk/rooms/${id}/messages`, "POST", {
          requestId: randomUUID(),
          text: "before assignment",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/talk/rooms/${id}/assign-self`, "POST", {
          memberId: r.actors[1]!.id,
        })
      ).status,
    ).toBe(400);
    const assigned = await request(`/talk/rooms/${id}/assign-self`, "POST", {});
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({
      status: "in_progress",
      assignedMemberId: r.actors[0]!.id,
    });
  });
  it("consumes genuine trusted assignments atomically and rejects tampering, cross-room/session/tenant binding and replay", async () => {
    const key = createHmac(
      "sha256",
      Buffer.from(r.fixtures[0]!.serviceKey, "base64url"),
    )
      .update("jgw-talk-assignment-v1:" + r.fixtures[0]!.tenant)
      .digest();
    const sign = (changes: Record<string, unknown> = {}) => {
      const iat = Math.floor(Date.now() / 1000),
        nonce = randomUUID();
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          tenant: r.fixtures[0]!.tenant,
          room: id,
          member: r.actors[0]!.id,
          actor: r.actors[0]!.id,
          sid: decodeJwt(r.actors[0]!.token).sid,
          iat,
          exp: iat + 10,
          nonce,
          ...changes,
        }),
      ).toString("base64url");
      return {
        nonce,
        authorization:
          payload +
          "." +
          createHmac("sha256", key).update(payload).digest("base64url"),
      };
    };
    const path = `/talk/rooms/${id}/assign`,
      memberId = r.actors[0]!.id;
    expect((await request(path, "POST", { memberId })).status).toBe(400);
    for (const changes of [
      { tenant: r.fixtures[1]!.tenant },
      { room: randomUUID() },
      { sid: "another-session" },
      { actor: randomUUID() },
      { member: randomUUID() },
      { iat: 1, exp: 11 },
    ])
      expect(
        (
          await request(path, "POST", {
            memberId,
            authorization: sign(changes).authorization,
          })
        ).status,
      ).toBe(403);
    expect(
      (await request(path, "POST", { memberId, authorization: "forgery" }))
        .status,
    ).toBe(403);
    const proof = sign();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(path, "POST", { memberId, authorization: proof.authorization }),
      ),
    );
    expect(results.map((x) => x.status).sort()).toEqual([200, 409, 409]);
    const result = (await results.find((x) => x.status === 200)!.json()) as {
      occurrenceId: string;
    };
    expect(
      (
        await r.pool.query(
          "SELECT count(*)::int AS count FROM assignment_receipts WHERE tenant_id=$1 AND nonce=$2",
          [r.fixtures[0]!.tenant, proof.nonce],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await r.pool.query(
          "SELECT recipient_member_id FROM event_outbox WHERE tenant_id=$1 AND id=$2",
          [r.fixtures[0]!.tenant, result.occurrenceId],
        )
      ).rows[0].recipient_member_id,
    ).toBe(memberId);
  });
  it("commits member text and one outbox row atomically, deduplicates, paginates in commit order and bounds UTF-8 bytes", async () => {
    const key = randomUUID(),
      body = {
        requestId: key,
        text: "<script>plain text, not HTML rendering</script>",
      },
      url = `/talk/rooms/${id}/messages`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(url, "POST", body)),
    );
    expect(results.every((x) => x.status === 200)).toBe(true);
    const messages = await Promise.all(
      results.map((x) => x.json() as Promise<{ id: string; delivery: string }>),
    );
    expect(new Set(messages.map((x) => x.id)).size).toBe(1);
    expect(messages[0]!.delivery).toBe("pending");
    expect(
      (await request(url, "POST", { ...body, text: "different" })).status,
    ).toBe(409);
    const second = await request(url, "POST", {
      requestId: randomUUID(),
      text: "second message",
    });
    expect(second.status).toBe(200);
    const page = (await (
      await request(url + "?limit=1", "GET", undefined, r.actors[1]!.token)
    ).json()) as { items: { id: string; text: string }[]; next: string };
    expect(page.items[0]!.text).toBe(body.text);
    expect(page.next).toBe(messages[0]!.id);
    const following = (await (
      await request(
        url + "?after=" + page.next,
        "GET",
        undefined,
        r.actors[1]!.token,
      )
    ).json()) as { items: { text: string }[]; next: null };
    expect(following.items[0]!.text).toBe("second message");
    expect(following.next).toBeNull();
    for (const text of [" ", "가".repeat(1366)])
      expect(
        (await request(url, "POST", { requestId: randomUUID(), text })).status,
      ).toBe(400);
    expect(
      (
        await request(url, "POST", {
          requestId: randomUUID(),
          text: "identity injection",
          senderMemberId: r.actors[1]!.id,
        })
      ).status,
    ).toBe(400);
    const counts = (
      await r.pool.query(
        "SELECT (SELECT count(*) FROM messages WHERE tenant_id=$1 AND room_id=$2)::int AS messages,(SELECT count(*) FROM event_outbox WHERE tenant_id=$1 AND room_id=$2 AND type='talk.message')::int AS events",
        [r.fixtures[0]!.tenant, id],
      )
    ).rows[0];
    expect(counts).toEqual({ messages: 2, events: 2 });
  });
  it("rolls back a real outbox failure without a committed message", async () => {
    await r.pool.query(
      "CREATE FUNCTION fixture_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture outbox refusal'; END $$",
    );
    await r.pool.query(
      "CREATE TRIGGER fixture_fail_outbox BEFORE INSERT ON event_outbox FOR EACH ROW EXECUTE FUNCTION fixture_fail_outbox()",
    );
    const requestId = randomUUID();
    try {
      expect(
        (
          await request(`/talk/rooms/${id}/messages`, "POST", {
            requestId,
            text: "must roll back",
          })
        ).status,
      ).toBe(503);
      expect(
        (
          await r.pool.query(
            "SELECT count(*)::int AS count FROM messages WHERE tenant_id=$1 AND request_id=$2",
            [r.fixtures[0]!.tenant, requestId],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await r.pool.query("DROP TRIGGER fixture_fail_outbox ON event_outbox");
      await r.pool.query("DROP FUNCTION fixture_fail_outbox()");
    }
  });
  it("enforces the one-open-room FK/index and serializes close against further writes; new visitor production remains unbound", async () => {
    await expect(
      r.pool.query(
        "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
        [r.fixtures[0]!.tenant, randomUUID(), visitor],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      r.pool.query(
        "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
        [r.fixtures[1]!.tenant, randomUUID(), visitor],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await request(`/talk/rooms/${id}/close`, "POST", {})).status).toBe(
      200,
    );
    for (const [action, body] of [
      ["close", {}],
      ["assign-self", {}],
      ["messages", { requestId: randomUUID(), text: "after close" }],
    ] as const)
      expect(
        (await request(`/talk/rooms/${id}/${action}`, "POST", body)).status,
      ).toBe(409);
    expect(
      (await request("/ext/talk/v1/visitor-token", "POST", {})).status,
    ).toBe(404);
    expect((await request("/talk/rooms?tenant=foreign")).status).toBe(400);
  });
});
