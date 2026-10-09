import type { Pool } from "pg";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { talkNotificationDedupKey } from "@j-talk/contracts";
interface Event {
  id: string;
  room_id: string;
  type: "talk.new" | "talk.assigned";
  recipient_member_id: string | null;
  lease_token: string;
  attempts: number;
}
export function notificationEndpoint(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.port === "3001" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Notifications require an explicit loopback origin.");
  return url.origin + "/internal/notifications";
}
export class NotificationSender {
  private readonly endpoint: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<boolean> | undefined;
  private stopped = false;
  private controller: AbortController | undefined;
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
    url: string,
    private readonly key: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    assertCustomerTenantId(tenant);
    this.endpoint = notificationEndpoint(url);
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(key))
      throw new Error("Private notification key required.");
  }
  async tick(): Promise<boolean> {
    if (this.stopped) return false;
    const client = await this.pool.connect();
    let event: Event | undefined;
    try {
      await client.query("BEGIN");
      event = (
        await client.query<Event>(
          `WITH candidate AS (SELECT id FROM event_outbox WHERE tenant_id=$1 AND type IN ('talk.new','talk.assigned') AND delivered_at IS NULL AND available_at<=clock_timestamp() AND (locked_until IS NULL OR locked_until<=clock_timestamp()) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE event_outbox o SET attempts=o.attempts+1,lease_token=gen_random_uuid(),locked_until=clock_timestamp()+interval '20 seconds' FROM candidate c WHERE o.tenant_id=$1 AND o.id=c.id RETURNING o.*`,
          [this.tenant],
        )
      ).rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!event) return false;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        headers: {
          "Content-Type": "application/json",
          "X-JGW-Internal-Key": this.key,
        },
        body: JSON.stringify({
          tenant: this.tenant,
          service: "j-talk",
          type: event.type,
          ...(event.type === "talk.new"
            ? { role: "talk:read" }
            : { members: [event.recipient_member_id] }),
          title: event.type === "talk.new" ? "새 문의" : "문의 배정",
          body:
            event.type === "talk.new"
              ? "새 문의가 도착했습니다."
              : "문의가 배정되었습니다.",
          link: "/talk/rooms/" + event.room_id,
          dedupKey: talkNotificationDedupKey(event.room_id, event.id),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Delivery failed.");
      }
      const size = Number(response.headers.get("content-length") ?? 0);
      if (size > 1024) {
        await response.body?.cancel();
        throw new Error("Invalid receipt.");
      }
      if (
        !response.headers.get("content-type")?.startsWith("application/json")
      ) {
        await response.body?.cancel();
        throw new Error("Invalid receipt.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Invalid receipt.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > 1024) throw new Error("Invalid receipt.");
          chunks.push(result.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      const receipt = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: unknown;
        duplicate?: unknown;
      };
      if (
        typeof receipt.id !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(receipt.id) ||
        typeof receipt.duplicate !== "boolean"
      )
        throw new Error("Invalid receipt.");
      await this.pool.query(
        "UPDATE event_outbox SET delivered_at=clock_timestamp(),locked_until=NULL,lease_token=NULL,last_error=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND delivered_at IS NULL",
        [this.tenant, event.id, event.lease_token],
      );
    } catch {
      await this.pool.query(
        "UPDATE event_outbox SET available_at=clock_timestamp()+$4::int*interval '1 second',locked_until=NULL,lease_token=NULL,last_error='delivery_failed' WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND delivered_at IS NULL",
        [
          this.tenant,
          event.id,
          event.lease_token,
          Math.min(60, 2 ** Math.min(event.attempts, 6)),
        ],
      );
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
    return true;
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const run = () => {
      if (this.pending) return;
      this.pending = this.tick()
        .catch(() => false)
        .finally(() => {
          this.pending = undefined;
        });
    };
    this.timer = setInterval(run, 1000);
    this.timer.unref();
    run();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.pending;
  }
}
