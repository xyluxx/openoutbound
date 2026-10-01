// Verify an OpenOutbound webhook in any Node 22+ server (no dependencies).
// Header format: OpenOutbound-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Returns true when the signature matches and is recent.
 * @param {string} rawBody The exact request body as received (do not re-serialize JSON).
 * @param {string | undefined} header The OpenOutbound-Signature header value.
 * @param {string} secret The endpoint secret shown when the webhook was created.
 * @param {number} toleranceSeconds Maximum age of the signature.
 */
export function verifyOpenOutboundSignature(rawBody, header, secret, toleranceSeconds = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Example: node verify-signature.mjs
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("verify-signature.mjs")
) {
  const secret = "whsec_example";
  const body = JSON.stringify({ id: "evt_example", type: "reply.received", data: {} });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  console.log("valid:", verifyOpenOutboundSignature(body, `t=${t},v1=${v1}`, secret));
  console.log("tampered:", verifyOpenOutboundSignature(`${body} `, `t=${t},v1=${v1}`, secret));
}
