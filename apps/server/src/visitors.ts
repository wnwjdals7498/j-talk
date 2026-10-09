import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { TALK_VISITOR_POLICY } from "@j-talk/contracts";
import type { TalkVisitorToken } from "@j-talk/contracts";
import type { TalkSettings } from "./settings.js";
import { ApiError, missing } from "./errors.js";

export interface VisitorIdentity {
  id: string;
  hash: string;
  guestId: string | null;
  expiresAt: Date;
}
const unauthorized = () =>
  new ApiError(
    401,
    "invalid_visitor",
    "Visitor credential expired or revoked.",
  );
export function visitorHash(authorization: unknown): string {
  if (
    typeof authorization !== "string" ||
    !/^Bearer jtv_[A-Za-z0-9_-]{43}$/.test(authorization)
  )
    throw unauthorized();
  return createHash("sha256").update(authorization.slice(7)).digest("hex");
}
export class TalkVisitors {
  constructor(
    readonly pool: Pool,
    readonly tenant: string,
    private readonly settings: TalkSettings,
  ) {}
  private async transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  private async rate(
    client: PoolClient,
    kind: "issue" | "message",
    subject: string,
    maximum: number,
  ) {
    const result = await client.query<{ count: number }>(
      `INSERT INTO visitor_rate_limits(tenant_id,kind,subject,window_start,count)
       VALUES($1,$2,$3,clock_timestamp(),1)
       ON CONFLICT(tenant_id,kind,subject) DO UPDATE SET
       count=CASE WHEN visitor_rate_limits.window_start<=clock_timestamp()-interval '1 minute' THEN 1 ELSE visitor_rate_limits.count+1 END,
       window_start=CASE WHEN visitor_rate_limits.window_start<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE visitor_rate_limits.window_start END
       RETURNING count`,
      [this.tenant, kind, subject],
    );
    if (result.rows[0]!.count > maximum)
      throw new ApiError(429, "rate_limited", "Wait before trying again.");
  }
  private async credential(
    client: PoolClient,
    id: string,
  ): Promise<TalkVisitorToken> {
    const token = "jtv_" + randomBytes(32).toString("base64url");
    const result = await client.query<{ expires_at: Date }>(
      `INSERT INTO visitor_credentials(tenant_id,token_hash,visitor_id,expires_at)
       VALUES($1,$2,$3,clock_timestamp()+$4::int*interval '1 second') RETURNING expires_at`,
      [
        this.tenant,
        visitorHash("Bearer " + token),
        id,
        TALK_VISITOR_POLICY.tokenSeconds,
      ],
    );
    return { token, expiresAt: result.rows[0]!.expires_at.toISOString() };
  }
  async issue(ip: string, signature: unknown) {
    // Invalid or absent site signatures remain anonymous, as specified in S7.
    const guestId = await this.settings.verifyGuest(signature);
    return this.transaction(async (client) => {
      await this.rate(
        client,
        "issue",
        createHash("sha256")
          .update(this.tenant + ":" + ip)
          .digest("hex"),
        TALK_VISITOR_POLICY.issuePerMinute,
      );
      let id: string | undefined;
      if (guestId !== null) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [this.tenant + ":talk-guest:" + guestId],
        );
        id = (
          await client.query<{ id: string }>(
            "SELECT id FROM visitors WHERE tenant_id=$1 AND guest_id=$2 ORDER BY created_at,id LIMIT 1 FOR UPDATE",
            [this.tenant, guestId],
          )
        ).rows[0]?.id;
      }
      if (!id) {
        id = randomUUID();
        await client.query(
          "INSERT INTO visitors(tenant_id,id,guest_id) VALUES($1,$2,$3)",
          [this.tenant, id, guestId],
        );
      }
      // A new credential can join a verified guest; an old credential never changes owner.
      return this.credential(client, id);
    });
  }
  async authenticate(authorization: unknown): Promise<VisitorIdentity> {
    const hash = visitorHash(authorization);
    const row = (
      await this.pool.query<{
        id: string;
        guest_id: string | null;
        expires_at: Date;
      }>(
        `SELECT v.id,v.guest_id,c.expires_at FROM visitor_credentials c
         JOIN visitors v ON (v.tenant_id,v.id)=(c.tenant_id,c.visitor_id)
         WHERE c.tenant_id=$1 AND c.token_hash=$2 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()`,
        [this.tenant, hash],
      )
    ).rows[0];
    if (!row) throw unauthorized();
    return {
      id: row.id,
      hash,
      guestId: row.guest_id,
      expiresAt: row.expires_at,
    };
  }
  async rotate(identity: VisitorIdentity) {
    return this.transaction(async (client) => {
      await client.query(
        "SELECT id FROM visitors WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.tenant, identity.id],
      );
      const current = await client.query(
        `UPDATE visitor_credentials SET revoked_at=clock_timestamp()
         WHERE tenant_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING visitor_id`,
        [this.tenant, identity.hash],
      );
      if (!current.rowCount) throw unauthorized();
      return this.credential(client, identity.id);
    });
  }
  async revoke(id: string) {
    return this.transaction(async (client) => {
      await client.query(
        "SELECT id FROM visitors WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.tenant, id],
      );
      const result = await client.query(
        "UPDATE visitor_credentials SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND visitor_id=$2 RETURNING visitor_id",
        [this.tenant, id],
      );
      if (!result.rowCount) throw missing();
      return { revoked: true };
    });
  }
  async session(identity: VisitorIdentity) {
    const room = (
      await this.pool.query(
        `SELECT id,status,assigned_member_id AS "assignedMemberId",$3::text AS "guestId"
         FROM rooms WHERE tenant_id=$1 AND visitor_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [this.tenant, identity.id, identity.guestId],
      )
    ).rows[0];
    return {
      guestId: identity.guestId,
      room: room ?? null,
      expiresAt: identity.expiresAt.toISOString(),
    };
  }
  async send(identity: VisitorIdentity, requestId: string, text: string) {
    if (!text.trim() || Buffer.byteLength(text) > TALK_VISITOR_POLICY.textBytes)
      throw new ApiError(
        400,
        "invalid_input",
        "Text must contain 1–4096 bytes.",
      );
    return this.transaction(async (client) => {
      const current = await client.query(
        `SELECT v.id FROM visitors v JOIN visitor_credentials c ON (c.tenant_id,c.visitor_id)=(v.tenant_id,v.id)
         WHERE c.tenant_id=$1 AND c.token_hash=$2 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() FOR UPDATE OF v,c`,
        [this.tenant, identity.hash],
      );
      if (!current.rowCount) throw unauthorized();
      const previous = (
        await client.query<{ id: string; room_id: string; text: string }>(
          "SELECT id,room_id,text FROM messages WHERE tenant_id=$1 AND sender_visitor_id=$2 AND request_id=$3",
          [this.tenant, identity.id, requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.text !== text)
          throw new ApiError(
            409,
            "request_conflict",
            "Request id already used.",
          );
        return { id: previous.id, roomId: previous.room_id };
      }
      await this.rate(
        client,
        "message",
        identity.id,
        TALK_VISITOR_POLICY.messagesPerMinute,
      );
      let room = (
        await client.query<{ id: string }>(
          "SELECT id FROM rooms WHERE tenant_id=$1 AND visitor_id=$2 AND status<>'closed' FOR UPDATE",
          [this.tenant, identity.id],
        )
      ).rows[0]?.id;
      if (!room) {
        room = randomUUID();
        await client.query(
          "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES($1,$2,$3)",
          [this.tenant, room, identity.id],
        );
      }
      const id = randomUUID();
      await client.query(
        "INSERT INTO messages(tenant_id,id,room_id,sender_visitor_id,request_id,text) VALUES($1,$2,$3,$4,$5,$6)",
        [this.tenant, id, room, identity.id, requestId, text],
      );
      await client.query(
        "INSERT INTO event_outbox(tenant_id,id,room_id,message_id,type) VALUES($1,$2,$3,$4,'talk.message')",
        [this.tenant, randomUUID(), room, id],
      );
      return { id, roomId: room };
    });
  }
}
