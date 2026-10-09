import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerifiedIdentity } from "@j-auth/token-verifier";
import {
  TALK_ASSIGNMENT_TTL_SECONDS,
  TALK_UUID_PATTERN,
} from "@j-talk/contracts";
import { ApiError, unavailable } from "./errors.js";

export function assignmentVerifier(tenant: string, key?: string) {
  if (key !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(key))
    throw new Error("Invalid assignment binding.");
  return (
    proof: string,
    room: string,
    member: string,
    actor: VerifiedIdentity,
  ) => {
    if (!key) throw unavailable();
    try {
      const parts = proof.split(".");
      if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)))
        throw new Error();
      const payload = parts[0]!,
        signature = parts[1]!;
      const expected = createHmac("sha256", Buffer.from(key, "base64url"))
        .update(payload)
        .digest();
      const provided = Buffer.from(signature, "base64url");
      if (
        provided.toString("base64url") !== signature ||
        provided.length !== expected.length ||
        !timingSafeEqual(expected, provided)
      )
        throw new Error();
      const data = JSON.parse(
        Buffer.from(payload, "base64url").toString(),
      ) as Record<string, unknown>;
      const now = Math.floor(Date.now() / 1000);
      if (
        Object.keys(data).sort().join(",") !==
          "actor,exp,iat,member,nonce,room,sid,tenant,v" ||
        data.v !== 1 ||
        data.tenant !== tenant ||
        data.room !== room ||
        data.member !== member ||
        data.actor !== actor.subject ||
        data.sid !== actor.claims.sid ||
        typeof data.nonce !== "string" ||
        !new RegExp(TALK_UUID_PATTERN).test(data.nonce) ||
        !Number.isSafeInteger(data.iat) ||
        !Number.isSafeInteger(data.exp) ||
        Number(data.iat) > now + 1 ||
        Number(data.exp) !== Number(data.iat) + TALK_ASSIGNMENT_TTL_SECONDS ||
        Number(data.exp) <= now
      )
        throw new Error();
      return {
        nonce: data.nonce,
        expiresAt: new Date(Number(data.exp) * 1000),
      };
    } catch {
      throw new ApiError(
        403,
        "invalid_assignment",
        "Trusted assignment required.",
      );
    }
  };
}
