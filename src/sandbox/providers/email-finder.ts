/**
 * Sandbox email_finder provider: deterministic first.last@domain guesses, found about 80% of the
 * time (hashed from the input so the same person always gets the same answer).
 */
import { normalizeDomain, splitName } from "../../lib/web/extract.js";
import type {
  EmailFinderProvider,
  FindEmailInput,
  FindEmailResult,
} from "../../providers/types.js";
import { classifyEmailStatus } from "../world/email-status.js";
import { CATCH_ALL_DOMAINS } from "../world/index.js";
import { slugify } from "../world/names.js";
import { hashRatio } from "../world/rng.js";

const FOUND_RATE = 0.8;

export function createSandboxEmailFinder(): EmailFinderProvider {
  return {
    id: "sandbox",
    async findEmail(input: FindEmailInput): Promise<FindEmailResult> {
      const domain = input.domain ? normalizeDomain(input.domain) : null;
      const split = splitName(input.full_name ?? "");
      const first = (input.first_name ?? split.first_name ?? "").trim();
      const last = (input.last_name ?? split.last_name ?? "").trim();
      if (!domain || !first) return { email: null, creditsUsed: 1 };

      const key = `find:${first.toLowerCase()}|${last.toLowerCase()}|${domain}`;
      if (hashRatio(key) >= FOUND_RATE) return { email: null, creditsUsed: 1 };

      const email = last
        ? `${slugify(first)}.${slugify(last)}@${domain}`
        : `${slugify(first)}@${domain}`;
      const status = classifyEmailStatus(email, CATCH_ALL_DOMAINS);
      return {
        email,
        status,
        confidence: status === "valid" ? 0.9 : 0.5,
        creditsUsed: 1,
      };
    },
  };
}
