import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import type { TalkEvent, TalkSync } from "@j-talk/contracts";
import { TALK_VISITOR_POLICY } from "@j-talk/contracts";
import { ApiError } from "./errors.js";

export class TalkStream {
  private key: Promise<Buffer> | undefined;
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
  ) {}
  private secret() {
    this.key ??= (async () => {
      await this.pool.query(
        "INSERT INTO realtime_cursor_keys(tenant_id,secret) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [this.tenant, randomBytes(32)],
      );
      const row = (
        await this.pool.query<{ secret: Buffer }>(
          "SELECT secret FROM realtime_cursor_keys WHERE tenant_id=$1",
          [this.tenant],
        )
      ).rows[0];
      if (!row) throw new Error("Cursor signing unavailable.");
      return row.secret;
    })().catch((error) => {
      this.key = undefined;
      throw error;
    });
    return this.key;
  }
  async sync(
    scope: string,
    visitor: string | null,
    cursor?: string,
  ): Promise<TalkSync> {
    const key = await this.secret();
    let position = "0";
    if (cursor !== undefined) {
      try {
        if (cursor.length > 2048) throw new Error();
        const parts = cursor.split(".");
        if (
          parts.length !== 2 ||
          !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))
        )
          throw new Error();
        const signature = Buffer.from(parts[1]!, "base64url");
        const expected = createHmac("sha256", key).update(parts[0]!).digest();
        if (
          signature.length !== expected.length ||
          !timingSafeEqual(signature, expected)
        )
          throw new Error();
        const value: unknown = JSON.parse(
          Buffer.from(parts[0]!, "base64url").toString(),
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        const x = value as Record<string, unknown>;
        if (
          Object.keys(x).sort().join(",") !== "exp,pos,scope,tenant,v" ||
          x.v !== 1 ||
          x.tenant !== this.tenant ||
          x.scope !== scope ||
          typeof x.pos !== "string" ||
          !/^(0|[1-9][0-9]{0,18})$/.test(x.pos) ||
          typeof x.exp !== "number" ||
          !Number.isSafeInteger(x.exp) ||
          x.exp <= Math.floor(Date.now() / 1000) ||
          x.exp >
            Math.floor(Date.now() / 1000) +
              TALK_VISITOR_POLICY.cursorSeconds +
              1
        )
          throw new Error();
        position = x.pos;
      } catch {
        throw new ApiError(
          400,
          "invalid_cursor",
          "Cursor is invalid or outside this stream.",
        );
      }
    }
    const rows = (
      await this.pool.query<{
        sequence: string;
        id: string;
        room_id: string;
        type: TalkEvent["type"];
        message_id: string | null;
        text: string | null;
        sender_member_id: string | null;
        sender_visitor_id: string | null;
        message_created_at: Date | null;
      }>(
        `SELECT e.sequence::text,e.id,e.room_id,e.type,m.id AS message_id,m.text,m.sender_member_id,m.sender_visitor_id,m.created_at AS message_created_at
         FROM event_outbox e JOIN rooms r ON (r.tenant_id,r.id)=(e.tenant_id,e.room_id)
         LEFT JOIN messages m ON (m.tenant_id,m.id)=(e.tenant_id,e.message_id)
         WHERE e.tenant_id=$1 AND e.sequence>$2::bigint AND ($3::uuid IS NULL OR r.visitor_id=$3)
         ORDER BY e.sequence LIMIT $4`,
        [this.tenant, position, visitor, TALK_VISITOR_POLICY.page + 1],
      )
    ).rows;
    const page = rows.slice(0, TALK_VISITOR_POLICY.page);
    position = page.at(-1)?.sequence ?? position;
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        tenant: this.tenant,
        scope,
        pos: position,
        exp: Math.floor(Date.now() / 1000) + TALK_VISITOR_POLICY.cursorSeconds,
      }),
    ).toString("base64url");
    return {
      items: page.map((x) => ({
        id: x.id,
        roomId: x.room_id,
        type: x.type,
        message:
          x.message_id !== null
            ? {
                id: x.message_id,
                text: x.text!,
                senderMemberId: x.sender_member_id,
                senderVisitorId: x.sender_visitor_id,
                createdAt: x.message_created_at!.toISOString(),
              }
            : null,
      })),
      cursor:
        payload +
        "." +
        createHmac("sha256", key).update(payload).digest("base64url"),
      hasMore: rows.length > TALK_VISITOR_POLICY.page,
    };
  }
}
