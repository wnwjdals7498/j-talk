import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { TALK_PATHS } from "@j-talk/contracts";
import { TalkSettings } from "../../apps/server/src/settings.js";
import { migrate } from "../../apps/server/src/db/migrate.js";
import { integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
describe("actual tenant talk settings and membership", () => {
  let r: Runtime, settings: TalkSettings;
  const origin = "https://site.example.test";
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    bearer = r.actors[0]!.token,
    port = 55045,
    extra: Record<string, string> = {},
  ) =>
    r.fetch(`https://auth.jgw.test:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  beforeAll(async () => {
    r = await integrationRuntime();
    settings = new TalkSettings(r.pool, r.fixtures[0]!.tenant);
  });
  afterAll(async () => {
    await r?.close();
  });
  it("uses an isolated non-superuser and checksum migration, denying cross-database access", async () => {
    await migrate(r.pool);
    expect(
      (
        await r.pool.query(
          "SELECT current_user, current_database() AS db, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0],
    ).toMatchObject({
      current_user: "jgw_talk",
      db: "jgw_talk",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    const other = new Pool({
      ...r.pool.options,
      database: "postgres",
      password: r.pool.options.password!,
    });
    try {
      await expect(other.query("SELECT 1")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await other.end();
    }
    const old = (
      await r.pool.query<{ name: string; checksum: string }>(
        "SELECT name,checksum FROM schema_migrations ORDER BY name LIMIT 1",
      )
    ).rows[0]!;
    await r.pool.query(
      "UPDATE schema_migrations SET checksum='altered' WHERE name=$1",
      [old.name],
    );
    try {
      await expect(migrate(r.pool)).rejects.toThrow("modified");
    } finally {
      await r.pool.query(
        "UPDATE schema_migrations SET checksum=$1 WHERE name=$2",
        [old.checksum, old.name],
      );
    }
    await migrate(r.pool);
    await expect(
      r.pool.query(
        "INSERT INTO allowed_origins (tenant_id,origin) VALUES (NULL,$1)",
        [origin],
      ),
    ).rejects.toThrow();
  });
  it("creates, paginates and deletes exact origins with tenant isolation and conflicts", async () => {
    expect((await request(TALK_PATHS.origins, "POST", { origin })).status).toBe(
      201,
    );
    expect((await request(TALK_PATHS.origins, "POST", { origin })).status).toBe(
      409,
    );
    expect(
      (
        await request(TALK_PATHS.origins, "POST", {
          origin: "https://z.example.test:8443",
        })
      ).status,
    ).toBe(201);
    const first = await request(TALK_PATHS.origins + "?limit=1");
    const page = (await first.json()) as { items: string[]; next: string };
    expect(page.items).toEqual([origin]);
    expect(page.next).toBe(origin);
    expect(
      await (
        await request(
          TALK_PATHS.origins + "?after=" + encodeURIComponent(page.next),
        )
      ).json(),
    ).toEqual({ items: ["https://z.example.test:8443"], next: null });
    expect(
      (
        await request(
          TALK_PATHS.origins,
          "DELETE",
          { origin },
          r.foreign,
          55049,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(TALK_PATHS.origins, "POST", { origin }, r.foreign, 55049))
        .status,
    ).toBe(201);
    expect(
      (await request(TALK_PATHS.origins, "DELETE", { origin })).status,
    ).toBe(204);
    expect(
      await (
        await request(TALK_PATHS.origins, "GET", undefined, r.foreign, 55049)
      ).json(),
    ).toEqual({ items: [origin], next: null });
    expect((await request(TALK_PATHS.origins, "POST", { origin })).status).toBe(
      201,
    );
  });
  it("rejects wildcard, path, canonicalization tricks, credentials, reserved ports and tenant body injection", async () => {
    for (const value of [
      "*",
      "null",
      "https://*.example.test",
      "https://SITE.example.test",
      "https://site.example.test/",
      "https://site.example.test/a",
      "https://u:p@site.example.test",
      "https://site.example.test?x=1",
      "https://site.example.test:443",
      "https://site.example.test:3001",
      "file:///etc/passwd",
    ])
      expect(
        (await request(TALK_PATHS.origins, "POST", { origin: value })).status,
      ).toBe(400);
    expect(
      (
        await request(TALK_PATHS.origins, "POST", {
          origin,
          tenant: r.fixtures[1]!.tenant,
        })
      ).status,
    ).toBe(400);
    expect((await request(TALK_PATHS.origins + "?tenant=other")).status).toBe(
      400,
    );
  });
  it("uses actual stored origin for HTTP and preflight, blocking missing/foreign/malformed origin", async () => {
    const accepted = await request(
      TALK_PATHS.visitorPreflight,
      "GET",
      undefined,
      "",
      55045,
      { Origin: origin },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);
    const pre = await request(
      TALK_PATHS.visitorPreflight,
      "OPTIONS",
      undefined,
      "",
      55045,
      {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-credentials")).toBe(null);
    for (const value of [
      "",
      "https://other.example.test",
      origin + "/x",
      origin + ":8443",
    ]) {
      const rejected = await request(
        TALK_PATHS.visitorPreflight,
        "GET",
        undefined,
        "",
        55045,
        value ? { Origin: value } : {},
      );
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("access-control-allow-origin")).toBe(null);
    }
    expect(
      (
        await request(
          TALK_PATHS.visitorPreflight,
          "OPTIONS",
          undefined,
          "",
          55045,
          { Origin: origin, "Access-Control-Request-Method": "POST" },
        )
      ).status,
    ).toBe(403);
  });
  it("enforces actual member reduced audience, role and bearer/cookie boundaries", async () => {
    for (const token of [
      "invalid",
      r.foreign,
      r.actors[0]!.original,
      r.actors[0]!.token.slice(0, -10) + "AAAAAAAAAA",
    ])
      expect(
        (await request(TALK_PATHS.origins, "GET", undefined, token)).status,
      ).toBe(401);
    expect(
      (await r.fetch("https://auth.jgw.test:55045" + TALK_PATHS.origins))
        .status,
    ).toBe(401);
    expect(
      (
        await request(
          TALK_PATHS.origins,
          "GET",
          undefined,
          r.actors[0]!.token,
          55045,
          { Cookie: "native=1" },
        )
      ).status,
    ).toBe(401);
    for (const token of [r.actors[1]!.token, r.actors[2]!.token]) {
      expect(
        (await request(TALK_PATHS.origins, "GET", undefined, token)).status,
      ).toBe(403);
      expect(
        (await request(TALK_PATHS.widgetKey, "POST", {}, token)).status,
      ).toBe(403);
    }
  });
  it("issues secrets once, verifies actual HMAC and rotates current/previous keys atomically", async () => {
    expect(await (await request(TALK_PATHS.widgetKey)).json()).toEqual({
      issued: false,
      previousValidUntil: null,
    });
    const first = (await (
      await request(TALK_PATHS.widgetKey, "POST", {})
    ).json()) as { key: string };
    r.secrets.add(first.key);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const signed = (key: string, tenant = r.fixtures[0]!.tenant) => ({
      guestId: "guest-a",
      exp,
      sig: createHmac("sha256", key)
        .update(`${tenant}|guest-a|${exp}`)
        .digest("base64url"),
    });
    expect(await settings.verifyGuest(signed(first.key))).toBe("guest-a");
    for (const value of [
      null,
      {},
      signed(first.key, r.fixtures[1]!.tenant),
      { ...signed(first.key), sig: "A".repeat(43) },
      { ...signed(first.key), exp: 1 },
      { ...signed(first.key), guestId: "other" },
      { ...signed(first.key), guestId: "a|b" },
    ])
      expect(await settings.verifyGuest(value)).toBe(null);
    const second = (await (
      await request(TALK_PATHS.widgetKey, "POST", {})
    ).json()) as { key: string; previousValidUntil: string };
    r.secrets.add(second.key);
    expect(await settings.verifyGuest(signed(first.key))).toBe("guest-a");
    expect(await settings.verifyGuest(signed(second.key))).toBe("guest-a");
    expect(
      await settings.verifyGuest(
        signed(first.key),
        Date.parse(second.previousValidUntil),
      ),
    ).toBe(null);
    const status = await (await request(TALK_PATHS.widgetKey)).text();
    expect(status).not.toContain(first.key);
    expect(status).not.toContain(second.key);
    const foreignSettings = new TalkSettings(r.pool, r.fixtures[1]!.tenant);
    expect(await foreignSettings.verifyGuest(signed(second.key))).toBe(null);
    const replies = await Promise.all([
      request(TALK_PATHS.widgetKey, "POST", {}),
      request(TALK_PATHS.widgetKey, "POST", {}),
    ]);
    const keys = await Promise.all(
      replies.map((x) => x.json() as Promise<{ key: string }>),
    );
    for (const { key } of keys) {
      r.secrets.add(key);
      expect(await settings.verifyGuest(signed(key))).toBe("guest-a");
    }
    expect(await settings.verifyGuest(signed(first.key))).toBe(null);
    expect(await settings.verifyGuest(signed(second.key))).toBe(null);
  });
  it("returns 503 on real fresh JWKS connection failure without granting access", async () => {
    const broken: typeof fetch = (input, init) =>
      r.fetch(
        String(input).replace("auth.jgw.test:58443", "127.0.0.1:59997"),
        init,
      );
    const port = await r.newApp(r.fixtures[0]!.tenant, 0, { fetch: broken });
    expect(
      (
        await request(
          TALK_PATHS.origins,
          "GET",
          undefined,
          r.actors[0]!.token,
          port,
        )
      ).status,
    ).toBe(503);
  });
  it("fails closed during actual dedicated DB stop and recovers without losing origins or keys", async () => {
    execFileSync("docker", ["stop", "suite-ready-talk-pg-20261008"], {
      stdio: "ignore",
    });
    try {
      expect((await request(TALK_PATHS.origins)).status).toBe(503);
      expect(
        (
          await request(
            TALK_PATHS.visitorPreflight,
            "GET",
            undefined,
            "",
            55045,
            { Origin: origin },
          )
        ).status,
      ).toBe(503);
    } finally {
      execFileSync("docker", ["start", "suite-ready-talk-pg-20261008"], {
        stdio: "ignore",
      });
    }
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await r.pool.query("SELECT 1");
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(ready).toBe(true);
    expect((await request(TALK_PATHS.origins)).status).toBe(200);
    expect((await request(TALK_PATHS.widgetKey)).status).toBe(200);
  });
});
