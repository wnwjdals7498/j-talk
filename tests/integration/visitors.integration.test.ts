import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import { integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import type { TalkVisitorToken, TalkSync } from "@j-talk/contracts";

describe("actual visitor HTTP/PG/WSS ownership and recovery", () => {
  let r: Runtime;
  const origin = "https://visitor.example.test";
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    port = 55045,
    site = origin,
  ) =>
    r.fetch(`https://auth.jgw.test:${port}${path}`, {
      method,
      headers: {
        Origin: site,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const issue = async (guest?: unknown) => {
    const response = await call(
      "/ext/talk/v1/tokens",
      "POST",
      guest ? { guest } : {},
    );
    expect(response.status).toBe(201);
    return (await response.json()) as TalkVisitorToken;
  };
  beforeAll(async () => {
    r = await integrationRuntime();
    for (const tenant of r.fixtures)
      await r.pool.query(
        "INSERT INTO allowed_origins(tenant_id,origin) VALUES($1,$2)",
        [tenant.tenant, origin],
      );
  });
  afterAll(async () => {
    await r?.pool.query(
      "DROP TRIGGER IF EXISTS fixture_visitor_outbox_fail ON event_outbox",
    );
    await r?.pool.query(
      "DROP FUNCTION IF EXISTS fixture_visitor_outbox_fail()",
    );
    await r?.close();
  });
  it("issues hash-only bounded opaque credentials and rejects missing Origin, unregistered Origin, member token and other tenant", async () => {
    const token = await issue();
    expect(token.token).toMatch(/^jtv_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(token.expiresAt) - Date.now()).toBeLessThanOrEqual(
      1800000,
    );
    const stored = await r.pool.query(
      "SELECT token_hash FROM visitor_credentials WHERE tenant_id=$1",
      [r.fixtures[0]!.tenant],
    );
    expect(
      stored.rows.every(
        (x) =>
          /^[a-f0-9]{64}$/.test(x.token_hash) &&
          !x.token_hash.includes(token.token),
      ),
    ).toBe(true);
    expect(
      (await call("/ext/talk/v1/session", "GET", undefined, token.token, 55049))
        .status,
    ).toBe(401);
    expect(
      (await call("/ext/talk/v1/session", "GET", undefined, r.actors[0]!.token))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          "/ext/talk/v1/tokens",
          "POST",
          {},
          undefined,
          55045,
          "https://blocked.example.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await r.fetch("https://auth.jgw.test:55045/ext/talk/v1/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await r.request("/talk/rooms", token.token)).status).toBe(401);
  });
  it("creates one waiting room and atomically deduplicates concurrent visitor messages without counting retries", async () => {
    const token = await issue(),
      body = { requestId: randomUUID(), text: "첫 문의 😀" };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        call("/ext/talk/v1/messages", "POST", body, token.token),
      ),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const values = await Promise.all(responses.map((x) => x.json()));
    expect(new Set(values.map((x) => JSON.stringify(x))).size).toBe(1);
    const counts = (
      await r.pool.query(
        "SELECT (SELECT count(*) FROM messages WHERE tenant_id=$1 AND request_id=$2)::int AS messages,(SELECT count(*) FROM event_outbox WHERE tenant_id=$1 AND room_id=$3 AND type='talk.message')::int AS events",
        [r.fixtures[0]!.tenant, body.requestId, values[0].roomId],
      )
    ).rows[0];
    expect(counts).toEqual({ messages: 1, events: 1 });
    expect(
      (
        await call(
          "/ext/talk/v1/messages",
          "POST",
          { ...body, text: "different" },
          token.token,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          "/ext/talk/v1/messages",
          "POST",
          { requestId: randomUUID(), text: "😀".repeat(1025) },
          token.token,
        )
      ).status,
    ).toBe(400);
  });
  it("joins only a freshly verified same guest, treats forged signatures as anonymous and never rebinds an existing credential", async () => {
    const issued = await r.fetch(
      "https://auth.jgw.test:55045/talk/settings/widget-key",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + r.actors[0]!.token,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(issued.status).toBe(200);
    const { key } = (await issued.json()) as { key: string };
    r.secrets.add(key);
    const guestId = randomUUID(),
      exp = Math.floor(Date.now() / 1000) + 300;
    const guest = {
      guestId,
      exp,
      sig: createHmac("sha256", key)
        .update(`${r.fixtures[0]!.tenant}|${guestId}|${exp}`)
        .digest("base64url"),
    };
    const a = await issue(guest),
      b = await issue(guest),
      invalid = await issue({ ...guest, sig: "A".repeat(43) });
    const body = { requestId: randomUUID(), text: "signed inquiry" };
    const response = await call("/ext/talk/v1/messages", "POST", body, a.token);
    const result = await response.json();
    const session = await (
      await call("/ext/talk/v1/session", "GET", undefined, b.token)
    ).json();
    expect(session.guestId).toBe(guestId);
    expect(session.room.id).toBe(result.roomId);
    expect(
      (
        await (
          await call("/ext/talk/v1/session", "GET", undefined, invalid.token)
        ).json()
      ).guestId,
    ).toBeNull();
    expect(
      (await call("/ext/talk/v1/messages", "POST", { ...body, guest }, a.token))
        .status,
    ).toBe(400);
    const foreign = await call(
      "/ext/talk/v1/tokens",
      "POST",
      { guest },
      undefined,
      55049,
    );
    expect(foreign.status).toBe(201);
    const foreignToken = ((await foreign.json()) as TalkVisitorToken).token;
    expect(
      (
        await (
          await call(
            "/ext/talk/v1/session",
            "GET",
            undefined,
            foreignToken,
            55049,
          )
        ).json()
      ).guestId,
    ).toBeNull();
  });
  it("rotates once, revokes the previous credential and rejects expired/revoked credentials", async () => {
    const token = await issue();
    const rotates = await Promise.all([
      call("/ext/talk/v1/tokens/rotate", "POST", {}, token.token),
      call("/ext/talk/v1/tokens/rotate", "POST", {}, token.token),
    ]);
    expect(rotates.map((x) => x.status).sort()).toEqual([200, 401]);
    const fresh = (await rotates
      .find((x) => x.status === 200)!
      .json()) as TalkVisitorToken;
    expect(
      (await call("/ext/talk/v1/session", "GET", undefined, token.token))
        .status,
    ).toBe(401);
    // The following update identifies the actual returned token without printing it.
    const { createHash } = await import("node:crypto");
    await r.pool.query(
      "UPDATE visitor_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND token_hash=$2",
      [
        r.fixtures[0]!.tenant,
        createHash("sha256").update(fresh.token).digest("hex"),
      ],
    );
    expect(
      (await call("/ext/talk/v1/session", "GET", undefined, fresh.token))
        .status,
    ).toBe(401);
  });
  it("recovers committed occurrences through signed scoped cursors and creates a new room after close", async () => {
    await r.pool.query(
      "DELETE FROM visitor_rate_limits WHERE tenant_id=$1 AND kind='issue'",
      [r.fixtures[0]!.tenant],
    );
    const a = await issue(),
      b = await issue();
    const send = await call(
      "/ext/talk/v1/messages",
      "POST",
      { requestId: randomUUID(), text: "history" },
      a.token,
    );
    const { roomId } = await send.json();
    const first = (await (
      await call("/ext/talk/v1/sync", "GET", undefined, a.token)
    ).json()) as TalkSync;
    expect(first.items.map((x) => x.type)).toEqual([
      "talk.new",
      "talk.message",
    ]);
    expect(
      (
        await call(
          "/ext/talk/v1/sync?cursor=" + encodeURIComponent(first.cursor),
          "GET",
          undefined,
          b.token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          "/ext/talk/v1/sync?cursor=" +
            encodeURIComponent(first.cursor.slice(0, -1) + "!"),
          "GET",
          undefined,
          a.token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await r.fetch(
          `https://auth.jgw.test:55045/talk/rooms/${roomId}/close`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + r.actors[0]!.token,
              "Content-Type": "application/json",
            },
            body: "{}",
          },
        )
      ).status,
    ).toBe(200);
    const second = (await (
      await call(
        "/ext/talk/v1/sync?cursor=" + encodeURIComponent(first.cursor),
        "GET",
        undefined,
        a.token,
      )
    ).json()) as TalkSync;
    expect(second.items.map((x) => x.type)).toEqual(["talk.closed"]);
    const newRoom = await (
      await call(
        "/ext/talk/v1/messages",
        "POST",
        { requestId: randomUUID(), text: "new inquiry" },
        a.token,
      )
    ).json();
    expect(newRoom.roomId).not.toBe(roomId);
  });
  it("streams through real TLS WSS first-frame authentication and closes when the credential is revoked", async () => {
    const token = await issue(),
      cert = await readFile(process.env.JT_TLS_CERTIFICATE!);
    const tls = { ca: cert, servername: "auth.jgw.test" };
    const socket = new WebSocket("wss://127.0.0.1:55045/ext/talk/v1/ws", {
      ...tls,
      headers: { Origin: origin },
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const first = new Promise<TalkSync>((resolve) =>
      socket.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as TalkSync),
      ),
    );
    socket.send(JSON.stringify({ type: "authenticate", token: token.token }));
    expect((await first).items).toEqual([]);
    const incoming = new Promise<TalkSync>((resolve) =>
      socket.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as TalkSync),
      ),
    );
    await call(
      "/ext/talk/v1/messages",
      "POST",
      { requestId: randomUUID(), text: "WSS actual" },
      token.token,
    );
    expect(
      (await incoming).items.some((x) => x.message?.text === "WSS actual"),
    ).toBe(true);
    const closed = new Promise<number>((resolve) =>
      socket.once("close", resolve),
    );
    const { createHash } = await import("node:crypto");
    await r.pool.query(
      "UPDATE visitor_credentials SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND token_hash=$2",
      [
        r.fixtures[0]!.tenant,
        createHash("sha256").update(token.token).digest("hex"),
      ],
    );
    expect(await closed).toBe(1008);
  });
  it("never advances sync past a lower uncommitted room occurrence across concurrent transactions", async () => {
    const tenant = r.fixtures[0]!.tenant,
      visitorA = randomUUID(),
      visitorB = randomUUID(),
      roomA = randomUUID(),
      roomB = randomUUID();
    await r.pool.query(
      "INSERT INTO visitors(tenant_id,id) VALUES($1,$2),($1,$3)",
      [tenant, visitorA, visitorB],
    );
    const initial = await r.request("/talk/sync", r.actors[1]!.token);
    expect(initial.status).toBe(200);
    const cursor = ((await initial.json()) as TalkSync).cursor;
    const a = await r.pool.connect(),
      b = await r.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const pid = (
        await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      await a.query(
        "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES($1,$2,$3)",
        [tenant, roomA, visitorA],
      );
      pending = b.query(
        "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES($1,$2,$3)",
        [tenant, roomB, visitorB],
      );
      let blocked = false;
      for (let n = 0; n < 30; n++) {
        const state = (
          await r.pool.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0];
        if (state?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      const hidden = await r.request(
        "/talk/sync?" + new URLSearchParams({ cursor }),
        r.actors[1]!.token,
      );
      expect(hidden.status).toBe(200);
      expect(((await hidden.json()) as TalkSync).items).toEqual([]);
      await a.query("COMMIT");
      await pending;
      await b.query("COMMIT");
      const recovered = await r.request(
        "/talk/sync?" + new URLSearchParams({ cursor }),
        r.actors[1]!.token,
      );
      expect(recovered.status).toBe(200);
      const events = ((await recovered.json()) as TalkSync).items;
      expect(events.map((event) => event.roomId)).toEqual([roomA, roomB]);
      expect(events.map((event) => event.type)).toEqual([
        "talk.new",
        "talk.new",
      ]);
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await pending?.catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }
  });
  it("enforces the actual message rate and rolls back a real outbox failure", async () => {
    const token = await issue();
    for (let n = 0; n < 20; n++)
      expect(
        (
          await call(
            "/ext/talk/v1/messages",
            "POST",
            { requestId: randomUUID(), text: "rate " + n },
            token.token,
          )
        ).status,
      ).toBe(200);
    expect(
      (
        await call(
          "/ext/talk/v1/messages",
          "POST",
          { requestId: randomUUID(), text: "over" },
          token.token,
        )
      ).status,
    ).toBe(429);
    const another = await issue(),
      requestId = randomUUID();
    await r.pool.query(
      "CREATE FUNCTION fixture_visitor_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture outbox refusal'; END $$",
    );
    await r.pool.query(
      "CREATE TRIGGER fixture_visitor_outbox_fail BEFORE INSERT ON event_outbox FOR EACH ROW EXECUTE FUNCTION fixture_visitor_outbox_fail()",
    );
    try {
      expect(
        (
          await call(
            "/ext/talk/v1/messages",
            "POST",
            { requestId, text: "rollback" },
            another.token,
          )
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
      await r.pool.query(
        "DROP TRIGGER fixture_visitor_outbox_fail ON event_outbox",
      );
      await r.pool.query("DROP FUNCTION fixture_visitor_outbox_fail()");
    }
  });
});
