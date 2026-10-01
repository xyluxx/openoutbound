import type { EmailStatus } from "../../core/enums.js";
import { hashRatio } from "./rng.js";

/**
 * Deterministic email status from a hash of the address: about 70% valid, 15% invalid, 10%
 * risky, 5% catch_all, except domains in `catchAllDomains` which always classify as catch_all
 * (a real mail server configured to accept anything). Shared by the world seed data (so stored
 * people look consistent) and the sandbox email_verifier provider (so re-verifying agrees).
 */
export function classifyEmailStatus(
  email: string,
  catchAllDomains: ReadonlySet<string>,
): EmailStatus {
  const domain = email.slice(email.indexOf("@") + 1);
  if (catchAllDomains.has(domain)) return "catch_all";
  const ratio = hashRatio(`verify:${email}`);
  if (ratio < 0.7) return "valid";
  if (ratio < 0.85) return "invalid";
  if (ratio < 0.95) return "risky";
  return "catch_all";
}
