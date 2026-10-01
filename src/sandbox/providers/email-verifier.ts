/**
 * Sandbox email_verifier provider: deterministic mix of valid, invalid, catch_all and risky,
 * from a hash of the address (see world/email-status.ts), except world catch-all domains which
 * always come back catch_all.
 */
import type { EmailStatus } from "../../core/enums.js";
import type { EmailVerifierProvider, VerifyEmailResult } from "../../providers/types.js";
import { classifyEmailStatus } from "../world/email-status.js";
import { CATCH_ALL_DOMAINS } from "../world/index.js";

const REASONS: Record<EmailStatus, string> = {
  valid: "accepted",
  invalid: "mailbox_not_found",
  catch_all: "catch_all_domain",
  risky: "low_deliverability",
  unknown: "not_checked",
  unverifiable: "greylisted",
};

export function createSandboxEmailVerifier(): EmailVerifierProvider {
  return {
    id: "sandbox",
    async verify(email: string): Promise<VerifyEmailResult> {
      const status = classifyEmailStatus(email, CATCH_ALL_DOMAINS);
      return { email, status, reason: REASONS[status], creditsUsed: 1 };
    },
  };
}
