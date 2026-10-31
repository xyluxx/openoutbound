/**
 * The cold email check's record on a person: the compliance provider's last verdict for the
 * address (`people.email_clearance`, written by the send job right before the first email,
 * see email/cold-email-check.ts), what it means for contactability, and how the engine
 * describes the address to the provider (where it came from, who the person is).
 *
 * Reason codes (stable): cold_email_consent_needed, cold_email_blocked. They apply while the
 * verdict stands (CLEARANCE_DAYS for the same address) and `compliance.cold_email_check.mode`
 * is `hold`; recorded consent (`custom.consent`) satisfies consent_needed, never blocked. An
 * `unknown` verdict is kept to show but never blocks the next attempt, which asks again.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { WorkspaceSettings } from "../../core/settings.js";
import { type EmailClearance, type Person, people } from "../../db/schema/index.js";
import type { AddressSource, EmailCheckInput, EmailCheckVerdict } from "../../providers/types.js";

/** How long a definite verdict stands for the same address and facts. */
export const CLEARANCE_DAYS = 30;
export const CLEARANCE_MS = CLEARANCE_DAYS * 86_400_000;

/** Contactability code per verdict that holds a cold email (`ok_to_email` has none). */
export const COLD_EMAIL_CODES: Record<Exclude<EmailCheckVerdict, "ok_to_email">, string> = {
  consent_needed: "cold_email_consent_needed",
  blocked: "cold_email_blocked",
  unknown: "cold_email_unknown",
};

/** Bump when the facts in `clearanceInputs` change, so older records are checked afresh. */
const INPUTS_VERSION = 1;

/** Providers whose addresses are bought data (lead databases and paid finders). */
const BOUGHT_SOURCES = new Set([
  "apollo",
  "icypeas",
  "findymail",
  "hunter",
  "prospeo",
  "google_maps",
]);

/**
 * How the engine got the address, in the provider's words: `published` when the page that
 * publishes it is recorded (the website crawler's `email_source`, or `custom.publication_url`),
 * `bought` when a lead database or a paid finder supplied it, else `unknown` (an import, a
 * manual entry, a guess: the engine never assumes an address was published).
 */
export function addressSourceOf(person: Pick<Person, "email_source" | "custom">): AddressSource {
  const source = (person.email_source ?? "").trim().toLowerCase();
  const page = person.custom?.publication_url;
  if (/^https?:\/\//.test(source) || source === "website") return "published";
  if (typeof page === "string" && page.trim()) return "published";
  if (BOUGHT_SOURCES.has(source)) return "bought";
  return "unknown";
}

/** The person's name for the provider (never the address itself), or null. */
export function recipientNameOf(
  person: Pick<Person, "full_name" | "first_name" | "last_name">,
): string | null {
  const name =
    person.full_name?.trim() ||
    [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

/** A fingerprint of the facts sent with the address, so a verdict is reused only for the same question. */
export function clearanceInputs(input: Omit<EmailCheckInput, "email" | "signal">): string {
  const facts = {
    v: INPUTS_VERSION,
    sender_country: input.sender_country,
    address_source: input.address_source,
    company_name: input.company_name ?? null,
    recipient_name: input.recipient_name ?? null,
    company_number: input.company_number ?? null,
    recipient_country: input.recipient_country ?? null,
    default_recipient_country: input.default_recipient_country ?? null,
    existing_customer: input.existing_customer === true,
    pitch: input.pitch ?? null,
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

/** The stored verdict when it is about the person's current address and not older than CLEARANCE_DAYS. */
export function currentClearance(
  person: Pick<Person, "email" | "email_clearance">,
  now: Date,
): EmailClearance | null {
  const stored = person.email_clearance;
  if (!stored || !person.email || stored.email !== person.email.trim().toLowerCase()) return null;
  const checkedAt = Date.parse(stored.checked_at);
  if (!Number.isFinite(checkedAt) || now.getTime() - checkedAt > CLEARANCE_MS) return null;
  return stored;
}

/**
 * A stored definite verdict that answers exactly this question (same address, same facts,
 * within CLEARANCE_DAYS), or null when the provider has to be asked. `unknown` is never reused.
 */
export function cachedClearance(
  person: Pick<Person, "email" | "email_clearance">,
  inputs: string,
  now: Date,
): EmailClearance | null {
  const stored = currentClearance(person, now);
  if (!stored || stored.inputs !== inputs || stored.verdict === "unknown") return null;
  return stored;
}

/**
 * The contactability codes a stored verdict adds (mode `hold` only): a `consent_needed`
 * verdict without recorded consent, or a `blocked` one. Views, enrollment and the sender all
 * read it, so a person the check held stays held until the verdict is stale or the facts change.
 */
export function clearanceReasons(
  person: Pick<Person, "email" | "email_clearance" | "custom">,
  settings: WorkspaceSettings,
  now: Date,
): string[] {
  if (settings.compliance.cold_email_check.mode !== "hold") return [];
  const stored = currentClearance(person, now);
  if (!stored) return [];
  const consent = person.custom?.consent === true;
  if (stored.verdict === "consent_needed" && !consent) return [COLD_EMAIL_CODES.consent_needed];
  if (stored.verdict === "blocked") return [COLD_EMAIL_CODES.blocked];
  return [];
}

/** Stores the provider's answer on the person (the context workspace only). */
export async function recordEmailClearance(
  ctx: OpContext,
  personId: string,
  clearance: EmailClearance,
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  await ctx.db
    .update(people)
    .set({ email_clearance: clearance })
    .where(and(eq(people.id, personId), eq(people.workspace_id, workspace.id)));
}
