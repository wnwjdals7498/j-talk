import { createHmac } from "node:crypto";
// Run only on the customer site server. Never bundle the key into browser HTML/JS.
export function guestAttributes(tenant, guestId, key, now = Date.now()) {
  if (
    !/^[a-z0-9-]{1,64}$/.test(tenant) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(guestId) ||
    typeof key !== "string" ||
    key.length < 20
  )
    throw new Error("Validated tenant, guest and server key required.");
  const exp = Math.floor(now / 1000) + 300;
  const sig = createHmac("sha256", key)
    .update(`${tenant}|${guestId}|${exp}`)
    .digest("base64url");
  return {
    "data-guest-id": guestId,
    "data-guest-exp": String(exp),
    "data-guest-sig": sig,
  };
}
