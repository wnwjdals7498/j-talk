import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  chromium,
  expect as browserExpect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";

const apiOrigin = "https://auth.jgw.test:55045";
const guestId = `browser-${randomUUID()}`;
const guestExp = Math.floor(Date.now() / 1000) + 300;
const visitorText = `실제 방문 문의 ${randomUUID().slice(0, 8)}`;
const liveReply = `실시간 담당자 응답 ${randomUUID().slice(0, 8)}`;
const recoveredReply = `재연결 후 복구 ${randomUUID().slice(0, 8)}`;
let runtime: Runtime;
let site: ReturnType<typeof createServer>;
let siteOrigin: string;
let context: BrowserContext;
let page: Page;
let roomId = "";
let guestKey = "";
let issueCount = 0;
let cursorSyncCount = 0;

const memberPost = (path: string, body: unknown) =>
  runtime.fetch(`${apiOrigin}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.actors[0]!.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const sendMemberReply = async (text: string) => {
  const response = await memberPost(`/talk/rooms/${roomId}/messages`, {
    requestId: randomUUID(),
    text,
  });
  expect(response.status).toBe(200);
};

const profileRoot =
  process.env.JGW_TEST_TMP_ROOT ?? "/tmp/jgw-task25-tests-1000";

beforeAll(async () => {
  runtime = await integrationRuntime();
  const tenant = runtime.fixtures[0]!.tenant;
  const keyResponse = await memberPost("/talk/settings/widget-key", {});
  expect(keyResponse.status).toBe(200);
  const keyData = (await keyResponse.json()) as { key: string };
  guestKey = keyData.key;
  runtime.secrets.add(guestKey);
  const guestSig = createHmac("sha256", guestKey)
    .update(`${tenant}|${guestId}|${guestExp}`)
    .digest("base64url");

  await new Promise<void>((resolve, reject) => {
    site = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>방문 상담 fixture</h1><script async src="${apiOrigin}/ext/talk/v1/widget.min.js" data-guest-id="${guestId}" data-guest-exp="${guestExp}" data-guest-sig="${guestSig}"></script></body></html>`,
      );
    });
    site.once("error", reject);
    site.listen(0, "127.0.0.1", () => resolve());
  });
  const address = site.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture HTTP bind failed.");
  siteOrigin = `http://127.0.0.1:${address.port}`;
  if (address.port === 3001)
    throw new Error("The reserved port cannot be used.");
  await runtime.pool.query(
    "INSERT INTO allowed_origins(tenant_id,origin) VALUES($1,$2)",
    [tenant, siteOrigin],
  );

  const cache = `${profileRoot}/talk-widget-cache`;
  const config = `${profileRoot}/talk-widget-config`;
  const profile =
    process.env.JGW_PROFILE_DIR ?? `${profileRoot}/talk-widget-profile`;
  await Promise.all(
    [cache, config, profile].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.JGW_CHROMIUM_PATH ?? "/usr/lib/chromium/chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    timeout: 20_000,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-breakpad",
      "--no-proxy-server",
      "--host-resolver-rules=MAP auth.jgw.test 127.0.0.1,EXCLUDE localhost",
    ],
    env: {
      ...process.env,
      TMPDIR: "/tmp",
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
    },
    viewport: { width: 360, height: 800 },
  });
  page = await context.newPage();
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        Object.defineProperty(window, "__jgwTalkTestSocket", {
          configurable: true,
          value: socket,
        });
        return socket;
      },
    });
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "auth.jgw.test")
      process.stderr.write(
        `widget-browser request failed: ${url.pathname} ${request.failure()?.errorText ?? "unknown"}\n`,
      );
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.hostname === "auth.jgw.test" && response.status() >= 400)
      process.stderr.write(
        `widget-browser response: ${response.status()} ${url.pathname}\n`,
      );
  });
  await page.route("**/ext/talk/v1/tokens", async (route) => {
    if (route.request().method() === "POST") issueCount++;
    await route.continue();
  });
  await page.route("**/ext/talk/v1/sync*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor"))
      cursorSyncCount++;
    await route.continue();
  });
}, 120_000);

afterAll(async () => {
  await context?.close();
  if (site?.listening)
    await new Promise<void>((resolve, reject) =>
      site.close((error) => (error ? reject(error) : resolve())),
    );
  await runtime?.close();
}, 120_000);

it("serves the real visitor widget over HTTP/WSS and recovers once from a browser disconnect", async () => {
  const tenant = runtime.fixtures[0]!.tenant;
  await page.goto(siteOrigin);
  await page.getByRole("button", { name: "상담" }).waitFor();
  expect(
    await page.evaluate(
      () => document.querySelector("body > div")?.shadowRoot?.mode,
    ),
  ).toBe("open");
  await page.waitForFunction(
    (key) => localStorage.getItem(key) !== null,
    `j-talk:v1:${apiOrigin}`,
  );
  const saved = await page.evaluate((key) => {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Record<
      string,
      unknown
    > | null;
    return value && { token: value.token, guest: value.guest };
  }, `j-talk:v1:${apiOrigin}`);
  expect(saved).not.toBeNull();
  expect(saved?.guest).toBe(guestId);
  expect(saved?.token).toMatch(/^jtv_[A-Za-z0-9_-]{43}$/);
  const credentialHash = createHash("sha256")
    .update(String(saved?.token))
    .digest("hex");
  const storedCredentials = await runtime.pool.query(
    "SELECT token_hash FROM visitor_credentials WHERE tenant_id=$1",
    [tenant],
  );
  expect(
    storedCredentials.rows.some((row) => row.token_hash === credentialHash),
  ).toBe(true);
  expect(
    storedCredentials.rows.some((row) => row.token_hash === saved?.token),
  ).toBe(false);
  expect(issueCount).toBe(1);

  await page.getByRole("button", { name: "상담" }).click();
  const input = page.getByRole("textbox", { name: "문의 메시지" });
  await browserExpect(input).toBeFocused();
  await input.fill(visitorText);
  await page.getByRole("button", { name: "보내기" }).click();
  const history = page.getByRole("list", { name: "대화 기록" });
  await browserExpect(history.getByText(`나: ${visitorText}`)).toBeVisible();

  const visitorRows = await runtime.pool.query(
    `SELECT r.id, count(m.id)::int AS message_count
       FROM rooms r JOIN messages m ON m.tenant_id=r.tenant_id AND m.room_id=r.id
      WHERE r.tenant_id=$1 AND m.sender_member_id IS NULL AND m.text=$2
      GROUP BY r.id`,
    [tenant, visitorText],
  );
  expect(visitorRows.rows).toHaveLength(1);
  roomId = visitorRows.rows[0]!.id as string;
  expect(visitorRows.rows[0]!.message_count).toBe(1);
  const visitorOutbox = await runtime.pool.query(
    `SELECT count(*)::int AS count FROM event_outbox o
       JOIN messages m ON m.tenant_id=o.tenant_id AND m.id=o.message_id
      WHERE o.tenant_id=$1 AND m.text=$2 AND o.type='talk.message'`,
    [tenant, visitorText],
  );
  expect(visitorOutbox.rows[0]!.count).toBe(1);

  const assigned = await memberPost(`/talk/rooms/${roomId}/assign-self`, {});
  expect(assigned.status).toBe(200);
  await sendMemberReply(liveReply);
  await browserExpect(history.getByText(`담당자: ${liveReply}`)).toBeVisible();

  const panel = page.getByRole("region", { name: "상담 대화" });
  const mobileBounds = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth };
  });
  expect(mobileBounds.left).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.right).toBeLessThanOrEqual(mobileBounds.width);

  const cursorBefore = cursorSyncCount;
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await page.evaluate(() => {
    const socket = (window as Window & { __jgwTalkTestSocket?: WebSocket })
      .__jgwTalkTestSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new Error("The actual visitor WebSocket is not open.");
    socket.close(4000, "Controlled fixture disconnect");
  });
  await browserExpect(page.getByRole("status")).toContainText(
    "연결 복구 중입니다.",
    { timeout: 10_000 },
  );
  await sendMemberReply(recoveredReply);
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await browserExpect(
    history.getByText(`담당자: ${recoveredReply}`),
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => cursorSyncCount, { timeout: 10_000 })
    .toBeGreaterThan(cursorBefore);
  expect(await history.getByText(`담당자: ${recoveredReply}`).count()).toBe(1);
  await session.detach();

  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopBounds = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth };
  });
  expect(desktopBounds.left).toBeGreaterThanOrEqual(0);
  expect(desktopBounds.right).toBeLessThanOrEqual(desktopBounds.width);

  const credentialBeforeReload = saved?.token;
  await page.reload();
  await page.getByRole("button", { name: "상담" }).waitFor();
  await page.getByRole("button", { name: "상담" }).click();
  const restoredHistory = page.getByRole("list", { name: "대화 기록" });
  await browserExpect(
    restoredHistory.getByText(`나: ${visitorText}`),
  ).toBeVisible();
  await browserExpect(
    restoredHistory.getByText(`담당자: ${liveReply}`),
  ).toBeVisible();
  await browserExpect(
    restoredHistory.getByText(`담당자: ${recoveredReply}`),
  ).toBeVisible();
  const afterReload = await page.evaluate((key) => {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Record<
      string,
      unknown
    > | null;
    return value && { token: value.token, guest: value.guest };
  }, `j-talk:v1:${apiOrigin}`);
  expect(afterReload?.token).toBe(credentialBeforeReload);
  expect(afterReload?.guest).toBe(guestId);
  expect(issueCount).toBe(1);
  expect(
    await restoredHistory.getByText(`담당자: ${recoveredReply}`).count(),
  ).toBe(1);
}, 60_000);
