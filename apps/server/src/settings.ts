import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import type {
  GuestSignature,
  IssuedWidgetKey,
  OriginPage,
  WidgetKeyStatus,
} from "@j-talk/contracts";
import { WIDGET_PREVIOUS_KEY_SECONDS } from "@j-talk/contracts";
import { ApiError, forbidden } from "./errors.js";

export function exactOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    throw new ApiError(400, "invalid_origin", "Exact origin required.");
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.origin !== value ||
      url.username ||
      url.password ||
      !url.hostname ||
      url.hostname.includes("*") ||
      url.port === "3001"
    )
      throw new Error();
    return value;
  } catch {
    throw new ApiError(400, "invalid_origin", "Exact origin required.");
  }
}
export class TalkSettings {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
  ) {}
  async listOrigins(limit: number, after?: string): Promise<OriginPage> {
    if (after !== undefined) exactOrigin(after);
    const r = await this.pool.query<{ origin: string }>(
      "SELECT origin FROM allowed_origins WHERE tenant_id=$1 AND ($2::text IS NULL OR origin > $2) ORDER BY origin LIMIT $3",
      [this.tenant, after ?? null, limit + 1],
    );
    const items = r.rows.slice(0, limit).map((x) => x.origin);
    return { items, next: r.rows.length > limit ? items.at(-1)! : null };
  }
  async addOrigin(value: unknown) {
    const origin = exactOrigin(value);
    const r = await this.pool.query(
      "INSERT INTO allowed_origins (tenant_id, origin) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [this.tenant, origin],
    );
    if (!r.rowCount)
      throw new ApiError(409, "origin_exists", "Origin already registered.");
    return { origin };
  }
  async removeOrigin(value: unknown) {
    const origin = exactOrigin(value);
    const r = await this.pool.query(
      "DELETE FROM allowed_origins WHERE tenant_id=$1 AND origin=$2",
      [this.tenant, origin],
    );
    if (!r.rowCount) throw new ApiError(404, "not_found", "Origin not found.");
  }
  async requireOrigin(value: unknown): Promise<string> {
    let origin: string;
    try {
      origin = exactOrigin(value);
    } catch {
      throw forbidden();
    }
    const r = await this.pool.query(
      "SELECT 1 FROM allowed_origins WHERE tenant_id=$1 AND origin=$2",
      [this.tenant, origin],
    );
    if (!r.rowCount) throw forbidden();
    return origin;
  }
  async keyStatus(): Promise<WidgetKeyStatus> {
    const r = await this.pool.query<{ previous_valid_until: Date | null }>(
      "SELECT previous_valid_until FROM widget_keys WHERE tenant_id=$1",
      [this.tenant],
    );
    return {
      issued: r.rows.length === 1,
      previousValidUntil:
        r.rows[0]?.previous_valid_until?.toISOString() ?? null,
    };
  }
  async issueKey(): Promise<IssuedWidgetKey> {
    const key = randomBytes(32).toString("base64url");
    const r = await this.pool.query<{ previous_valid_until: Date | null }>(
      `INSERT INTO widget_keys (tenant_id,current_key) VALUES ($1,$2)
      ON CONFLICT (tenant_id) DO UPDATE SET previous_key=widget_keys.current_key, current_key=EXCLUDED.current_key,
      rotated_at=now(), previous_valid_until=now()+($3::int * interval '1 second') RETURNING previous_valid_until`,
      [this.tenant, key, WIDGET_PREVIOUS_KEY_SECONDS],
    );
    return {
      key,
      previousValidUntil:
        r.rows[0]!.previous_valid_until?.toISOString() ?? null,
    };
  }
  async verifyGuest(value: unknown, now = Date.now()): Promise<string | null> {
    if (!value || typeof value !== "object") return null;
    const { guestId, exp, sig } = value as Partial<GuestSignature>;
    if (
      typeof guestId !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(guestId) ||
      !Number.isSafeInteger(exp) ||
      exp! <= Math.floor(now / 1000) ||
      typeof sig !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(sig)
    )
      return null;
    const bytes = Buffer.from(sig, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== sig) return null;
    const r = await this.pool.query<{
      current_key: string;
      previous_key: string | null;
      previous_valid_until: Date | null;
    }>(
      "SELECT current_key,previous_key,previous_valid_until FROM widget_keys WHERE tenant_id=$1",
      [this.tenant],
    );
    const row = r.rows[0];
    if (!row) return null;
    const payload = `${this.tenant}|${guestId}|${exp}`;
    const currentValid = timingSafeEqual(
      createHmac("sha256", row.current_key).update(payload).digest(),
      bytes,
    );
    const previousValid =
      row.previous_key !== null &&
      row.previous_valid_until !== null &&
      row.previous_valid_until.getTime() > now &&
      timingSafeEqual(
        createHmac("sha256", row.previous_key).update(payload).digest(),
        bytes,
      );
    return currentValid || previousValid ? guestId! : null;
  }
}
