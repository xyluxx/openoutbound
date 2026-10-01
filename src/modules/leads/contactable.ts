/**
 * Contactability: may we contact this person on this channel right now? The engine checks
 * this at enrollment and again before every send (spec 6, compliance playbook).
 *
 * Reason codes (stable): person_not_found, suppressed_email, suppressed_domain,
 * suppressed_linkedin, suppressed_person, suppressed_company, person_do_not_contact,
 * person_unsubscribed, person_bounced, person_customer, company_do_not_contact,
 * company_competitor, company_customer, company_on_hold, company_open_deal, company_owned,
 * no_email, no_linkedin, role_address, invalid_email, unverified_email, catch_all_skipped,
 * excluded_country, consent_required, publication_evidence_missing, uk_possible_sole_trader.
 *
 * company_on_hold, company_open_deal and company_owned stop new outreach only: they never
 * block answering someone who wrote to us (`OUTREACH_ONLY_REASONS`).
 *
 * When neither the person nor the company has a country, the email's ccTLD (.de, .co.uk,
 * .com.au, ...) stands in for the consent, publication evidence and UK sole trader checks.
 */
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../core/settings.js";
import type { Company, Person } from "../../db/schema/index.js";
import { parseEmployees } from "./normalize.js";
import { loadCompanies, loadPeople } from "./records.js";
import { isBlockedRoleAddress } from "./role-address.js";
import {
  findSuppressions,
  type SuppressionCandidate,
  suppressionCandidates,
  suppressionIndex,
  suppressionReason,
} from "./suppressions.js";
import { countryFromEmail } from "./tld-country.js";
import type { ContactableResult, ContactChannel } from "./types.js";

/**
 * Company-level codes that hold back new outreach but never an answer to someone who wrote to
 * us (a company hold, an open CRM deal, an account a sales rep owns).
 */
export const OUTREACH_ONLY_REASONS: ReadonlySet<string> = new Set([
  "company_on_hold",
  "company_open_deal",
  "company_owned",
]);

/**
 * Company-level outreach blocks: a hold until a future time, an open CRM deal (unless
 * `crm.allow_outreach_with_open_deal`), an account a sales rep owns (when
 * `crm.skip_owned_accounts`).
 */
export function companyOutreachReasons(
  company: Pick<Company, "hold_until" | "crm_open_deal" | "crm_owner"> | null,
  settings: WorkspaceSettings,
  now: Date,
): string[] {
  if (!company) return [];
  const reasons: string[] = [];
  if (company.hold_until && company.hold_until.getTime() > now.getTime()) {
    reasons.push("company_on_hold");
  }
  if (company.crm_open_deal && !settings.crm.allow_outreach_with_open_deal) {
    reasons.push("company_open_deal");
  }
  if (company.crm_owner?.trim() && settings.crm.skip_owned_accounts) {
    reasons.push("company_owned");
  }
  return reasons;
}

/** Pure rules part of the check (everything except suppressions); `now` decides company holds. */
export function contactabilityReasons(
  person: Person,
  company: Company | null,
  channel: ContactChannel,
  settings: WorkspaceSettings,
  now: Date,
): string[] {
  const reasons: string[] = [];
  if (person.status === "do_not_contact") reasons.push("person_do_not_contact");
  if (person.status === "unsubscribed") reasons.push("person_unsubscribed");
  if (person.status === "customer") reasons.push("person_customer");
  if (channel === "email" && person.status === "bounced") reasons.push("person_bounced");

  if (company?.status === "do_not_contact") reasons.push("company_do_not_contact");
  if (company?.status === "competitor") reasons.push("company_competitor");
  if (company?.status === "customer") reasons.push("company_customer");
  reasons.push(...companyOutreachReasons(company, settings, now));

  if (channel === "email") {
    if (person.email && isBlockedRoleAddress(person.email)) reasons.push("role_address");
    if (!person.email) {
      reasons.push("no_email");
    } else if (person.email_status === "invalid") {
      reasons.push("invalid_email");
    } else if (person.email_status === "catch_all") {
      if (settings.sending.catch_all === "skip") reasons.push("catch_all_skipped");
    } else if (settings.sending.require_verified_email && person.email_status !== "valid") {
      reasons.push("unverified_email");
    }
  } else if (!person.linkedin_url) {
    reasons.push("no_linkedin");
  }

  const country = person.country ?? company?.country ?? null;
  if (country && settings.compliance.excluded_countries.includes(country)) {
    reasons.push("excluded_country");
  }
  if (channel !== "email") return reasons;
  // Without a recorded country, the email's ccTLD decides the compliance rules below.
  const tldCountry = country ? null : countryFromEmail(person.email);
  const complianceCountry = country ?? tldCountry;
  if (!complianceCountry) return reasons;
  const consent = person.custom?.consent === true;
  if (settings.compliance.consent_required_countries.includes(complianceCountry) && !consent) {
    reasons.push("consent_required");
  }
  if (
    settings.compliance.publication_evidence_countries.includes(complianceCountry) &&
    !consent &&
    !hasPublicationEvidence(person)
  ) {
    reasons.push("publication_evidence_missing");
  }
  const companyCountry = company?.country ?? person.country ?? tldCountry;
  if (
    settings.compliance.uk_sole_trader_check &&
    companyCountry === "GB" &&
    !consent &&
    !hasCorporateLegalForm(company)
  ) {
    reasons.push("uk_possible_sole_trader");
  }
  return reasons;
}

/**
 * CASL / Spam Act style evidence: the address was published on a page we can point to
 * (email_source is that URL) or the page is recorded in custom.publication_url.
 */
export function hasPublicationEvidence(person: Pick<Person, "email_source" | "custom">): boolean {
  if (person.email_source && /^https?:\/\//i.test(person.email_source)) return true;
  const url = person.custom?.publication_url;
  return typeof url === "string" && url.trim().length > 0;
}

const CORPORATE_FORMS = new Set(["company", "llp", "plc", "corporate", "ltd", "limited"]);

/**
 * UK PECR: corporate subscribers (companies, LLPs) may get cold email; sole traders and some
 * partnerships count as individuals. Evidence: the name carries a corporate suffix (Ltd,
 * Limited, LLP, PLC, also dotted), custom.legal_form says so, or 10+ employees.
 */
export function hasCorporateLegalForm(
  company: Pick<Company, "name" | "custom" | "employee_count" | "employee_range"> | null,
): boolean {
  if (!company) return false;
  const name = company.name.toLowerCase().replace(/\./g, "");
  if (/\b(ltd|limited|llp|plc)\b/.test(name)) return true;
  const form = company.custom?.legal_form;
  if (typeof form === "string" && CORPORATE_FORMS.has(form.trim().toLowerCase())) return true;
  if (typeof company.employee_count === "number") return company.employee_count >= 10;
  const range = parseEmployees(company.employee_range).range;
  const min = range ? Number.parseInt(range, 10) : Number.NaN;
  return Number.isFinite(min) && min >= 10;
}

function candidatesFor(person: Person, company: Company | null): SuppressionCandidate[] {
  return suppressionCandidates({
    email: person.email,
    linkedin_url: person.linkedin_url,
    person_id: person.id,
    company_id: person.company_id,
    company_domain: company?.domain ?? null,
  });
}

/** Contactability for many people at once (one query per table). Missing ids get person_not_found. */
export async function checkContactableMany(
  ctx: OpContext,
  personIds: string[],
  channel: ContactChannel,
): Promise<Map<string, ContactableResult>> {
  const workspace = requireWorkspace(ctx);
  const settings = parseWorkspaceSettings(workspace.settings);
  const now = ctx.clock.now();
  const persons = await loadPeople(ctx, personIds);
  const companyIds = persons.map((p) => p.company_id).filter((id): id is string => Boolean(id));
  const companyById = new Map((await loadCompanies(ctx, companyIds)).map((c) => [c.id, c]));

  const candidatesByPerson = new Map<string, SuppressionCandidate[]>();
  for (const person of persons) {
    const company = person.company_id ? (companyById.get(person.company_id) ?? null) : null;
    candidatesByPerson.set(person.id, candidatesFor(person, company));
  }
  const index = suppressionIndex(
    await findSuppressions(ctx.db, workspace.id, [...candidatesByPerson.values()].flat()),
  );

  const results = new Map<string, ContactableResult>();
  for (const person of persons) {
    const company = person.company_id ? (companyById.get(person.company_id) ?? null) : null;
    const reasons: string[] = [];
    for (const candidate of candidatesByPerson.get(person.id) ?? []) {
      const hit = index.get(`${candidate.type}:${candidate.value}`);
      const code = hit ? suppressionReason(hit.type) : null;
      if (code && !reasons.includes(code)) reasons.push(code);
    }
    reasons.push(...contactabilityReasons(person, company, channel, settings, now));
    results.set(person.id, { ok: reasons.length === 0, reasons });
  }
  for (const id of personIds) {
    if (!results.has(id)) results.set(id, { ok: false, reasons: ["person_not_found"] });
  }
  return results;
}

/**
 * Can we contact this person on this channel right now? Checks every suppression type
 * (including hashed GDPR erasures), person and company status, channel data, email status vs
 * sending settings, and excluded and consent-required countries.
 */
export async function checkContactable(
  ctx: OpContext,
  input: { personId: string; channel: ContactChannel },
): Promise<ContactableResult> {
  const results = await checkContactableMany(ctx, [input.personId], input.channel);
  return results.get(input.personId) ?? { ok: false, reasons: ["person_not_found"] };
}

/**
 * Reasons we may not prospect this company at all: company or domain suppressions, status
 * (do_not_contact, competitor, customer), a company hold, an open CRM deal or an owned account
 * (`companyOutreachReasons`) and excluded countries. Used before spending on a company (website
 * contacts, imports of find results).
 */
export async function companyBlockReasons(ctx: OpContext, company: Company): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const settings = parseWorkspaceSettings(workspace.settings);
  const candidates = suppressionCandidates({
    company_id: company.id,
    company_domain: company.domain,
  });
  const index = suppressionIndex(await findSuppressions(ctx.db, workspace.id, candidates));
  const reasons: string[] = [];
  for (const candidate of candidates) {
    const hit = index.get(`${candidate.type}:${candidate.value}`);
    const code = hit ? suppressionReason(hit.type) : null;
    if (code && !reasons.includes(code)) reasons.push(code);
  }
  if (company.status === "do_not_contact") reasons.push("company_do_not_contact");
  if (company.status === "competitor") reasons.push("company_competitor");
  if (company.status === "customer") reasons.push("company_customer");
  reasons.push(...companyOutreachReasons(company, settings, ctx.clock.now()));
  if (company.country && settings.compliance.excluded_countries.includes(company.country)) {
    reasons.push("excluded_country");
  }
  return reasons;
}

/** Reasons that block every channel: opted out, do not contact, suppressed as a person or company, or gone. */
const ANY_CHANNEL_BLOCKS: ReadonlySet<string> = new Set([
  "person_do_not_contact",
  "person_unsubscribed",
  "suppressed_person",
  "company_do_not_contact",
  "suppressed_company",
  "person_not_found",
]);

/** Suppressions that block one channel only. */
const CHANNEL_BLOCKS: Record<ContactChannel, ReadonlySet<string>> = {
  email: new Set(["suppressed_email", "suppressed_domain"]),
  linkedin: new Set(["suppressed_linkedin"]),
};

/**
 * The people among `personIds` nobody may reach out to any more (see ANY_CHANNEL_BLOCKS), and
 * with `channel` also those suppressed on that channel. Work that only prompts contacting them,
 * such as an overdue promise or a stuck reply, lapses for them. Holds, deals and missing data do
 * not count: they stop outreach, not an answer.
 */
export async function peopleNotToContact(
  ctx: OpContext,
  personIds: readonly (string | null | undefined)[],
  channel?: ContactChannel,
): Promise<Set<string>> {
  const ids = [...new Set(personIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Set();
  const results = await checkContactableMany(ctx, ids, channel ?? "email");
  const blocks = (reason: string) =>
    ANY_CHANNEL_BLOCKS.has(reason) || (channel ? CHANNEL_BLOCKS[channel].has(reason) : false);
  return new Set(ids.filter((id) => results.get(id)?.reasons.some(blocks)));
}
