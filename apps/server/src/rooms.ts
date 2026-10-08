import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError, missing } from "./errors.js";
export class TalkRooms {
  constructor(
    private pool: Pool,
    private tenant: string,
  ) {}
  async list(status: string | undefined, limit: number, after?: string) {
    const rows = (
      await this.pool.query(
        `SELECT id,status,assigned_member_id AS "assignedMemberId",created_at AS "createdAt" FROM rooms WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
        [this.tenant, status ?? null, after ?? null, limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  async room(id: string) {
    const row = (
      await this.pool.query(
        `SELECT r.id,r.status,r.assigned_member_id AS "assignedMemberId",v.guest_id AS "guestId" FROM rooms r JOIN visitors v ON (v.tenant_id,v.id)=(r.tenant_id,r.visitor_id) WHERE r.tenant_id=$1 AND r.id=$2`,
        [this.tenant, id],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }
  async messages(id: string, limit: number, after?: string) {
    await this.room(id);
    if (
      after &&
      !(
        await this.pool.query(
          "SELECT 1 FROM messages WHERE tenant_id=$1 AND room_id=$2 AND id=$3",
          [this.tenant, id, after],
        )
      ).rowCount
    )
      throw new ApiError(
        400,
        "invalid_cursor",
        "Message cursor is outside this room.",
      );
    const rows = (
      await this.pool.query(
        `SELECT id,text,sender_member_id AS "senderMemberId",created_at AS "createdAt" FROM messages WHERE tenant_id=$1 AND room_id=$2 AND ($3::uuid IS NULL OR sequence>(SELECT sequence FROM messages WHERE tenant_id=$1 AND room_id=$2 AND id=$3)) ORDER BY sequence LIMIT $4`,
        [this.tenant, id, after ?? null, limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  async mutate<T>(
    id: string,
    run: (client: PoolClient, row: Record<string, unknown>) => Promise<T>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (
        await client.query(
          "SELECT * FROM rooms WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [this.tenant, id],
        )
      ).rows[0];
      if (!row) throw missing();
      if (row.status === "closed")
        throw new ApiError(409, "room_closed", "Room is closed.");
      const value = await run(client, row);
      await client.query("COMMIT");
      return value;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async assignSelf(id: string, member: string) {
    return this.mutate(id, async (client) => {
      await client.query(
        "UPDATE rooms SET assigned_member_id=$3,status='in_progress' WHERE tenant_id=$1 AND id=$2",
        [this.tenant, id, member],
      );
      return { id, status: "in_progress", assignedMemberId: member };
    });
  }
  async reply(id: string, member: string, requestId: string, text: string) {
    if (!text.trim() || Buffer.byteLength(text) > 4096)
      throw new ApiError(
        400,
        "invalid_input",
        "Text must contain 1–4096 bytes.",
      );
    return this.mutate(id, async (client, row) => {
      if (row.status !== "in_progress")
        throw new ApiError(
          409,
          "room_unassigned",
          "Assign the room before replying.",
        );
      const previous = (
        await client.query(
          "SELECT id,text FROM messages WHERE tenant_id=$1 AND room_id=$2 AND sender_member_id=$3 AND request_id=$4",
          [this.tenant, id, member, requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.text !== text)
          throw new ApiError(
            409,
            "request_conflict",
            "Request id already used.",
          );
        return { id: previous.id, delivery: "pending" };
      }
      const message = randomUUID();
      await client.query(
        "INSERT INTO messages(tenant_id,id,room_id,sender_member_id,request_id,text) VALUES ($1,$2,$3,$4,$5,$6)",
        [this.tenant, message, id, member, requestId, text],
      );
      await client.query(
        "INSERT INTO event_outbox(tenant_id,id,room_id,message_id,type) VALUES ($1,$2,$3,$4,'talk.message')",
        [this.tenant, randomUUID(), id, message],
      );
      return { id: message, delivery: "pending" };
    });
  }
  async close(id: string) {
    return this.mutate(id, async (client) => {
      await client.query(
        "UPDATE rooms SET status='closed',closed_at=now() WHERE tenant_id=$1 AND id=$2",
        [this.tenant, id],
      );
      return { id, status: "closed" };
    });
  }
}
