/**
 * The enrichment waterfall (spec 11.5), per person:
 * 1. Skip people we may never email (suppressed, do not contact, customer or competitor,
 *    excluded or consent-required country): no credits are spent on them.
 * 2. Verify the existing address when `verify_existing` is on (or in verify_only mode). A
 *    risky or unknown address checked in the last RECHECK_DAYS days is kept: the finders are
 *    not paid again until the check is stale, unless the caller forces it. The same holds when
 *    the paid finders found no address in the last RECHECK_DAYS days (email_not_found_at).
 * 3. Find: the website crawler (the person's own address published on the company site),
 *    then the finders in configured order; where cold email needs publication evidence
 *    (CA and AU by default), only the crawler runs, also for a stored address, so the page
 *    that publishes it is recorded as email_source.
 * 4. Verify what was found (finders that already report `valid` are trusted), dropping
 *    invalid results and moving on.
 * 5. Catch-all policy: a catch-all result ends the search (every address on that domain
 *    verifies the same way); sending decides later with settings.sending.catch_all.
 * 6. Optional pattern guesses (settings.data.enrichment.pattern_guessing, off by default)
 *    and a verified role address such as info@ (only when the caller allows it).
 * The result is stored with email_source (a page URL for website finds) and
 * email_checked_at; when the paid finders looked and nothing usable came of it,
 * email_not_found_at is set instead. `enrichment.completed` is emitted.
 *
 * Provider failures are their own outcome. A finder or verifier call that failed is the step
 * `<provider>:provider_failed` and an entry in `failed` (with the failure class and whether a
 * retry can help); a run that found nothing because of one is `provider_failed`, never
 * `not_found`. people.enrichment keeps the last run: its status, the finders that answered
 * "no match" (not asked again for RECHECK_DAYS), the finder whose address is on file
 * (`found_by`) and what failed. The next run asks only what failed: the shortcuts for a recent
 * check or a recent "no match" do not hold it back, and finders that already answered are
 * skipped, the one whose address is on file too while that address was checked within
 * RECHECK_DAYS (`<finder>:found_recently`, the address is kept). An automatic follow-up does
 * not repeat a step whose failure the engine may not repeat by itself (`retryable: false`, for
 * example a paid call that may already have used credits): it stays failed
 * (`<provider>:not_repeated`) until someone runs the enrichment again. email_not_found_at is
 * set only when no step failed and every finder asked answered.
 */
import { and, eq, ne } from "drizzle-orm";
import type { EmailStatus, EnrichStatus } from "../../core/enums.js";
import type { Failure } from "../../core/failures.js";
import {
  type Company,
  type EnrichmentFailedStep,
  type Person,
  type PersonEnrichment,
  people,
} from "../../db/schema/index.js";
import { isUniqueViolation } from "../leads/dedupe.js";
import { emailDomain, isFreeMailDomain, normalizeEmail } from "../leads/normalize.js";
import { isBlockedRoleAddress } from "../leads/role-address.js";
import { addressMatchesName, guessAddresses } from "./addresses.js";
import { blockedAddressReason } from "./blocked.js";
import { type EnrichmentSession, WEBSITE_FINDER } from "./session.js";

export const ENRICH_MODES = ["find_and_verify", "verify_only"] as const;
export type EnrichMode = (typeof ENRICH_MODES)[number];

/** Contactability reasons that make finding an email pointless (and a privacy problem). */
export const BLOCKING_REASONS = new Set([
  "person_not_found",
  "suppressed_email",
  "suppressed_domain",
  "suppressed_linkedin",
  "suppressed_person",
  "suppressed_company",
  "person_do_not_contact",
  "person_unsubscribed",
  "person_customer",
  "company_do_not_contact",
  "company_competitor",
  "company_customer",
  "excluded_country",
  "consent_required",
  "uk_possible_sole_trader",
]);

/**
 * Verified addresses are re-checked after this many days, and risky or unknown ones, or people
 * the finders found nothing for, are only looked for again (paid finders) after it.
 */
export const RECHECK_DAYS = 30;

export interface EnrichOutcome {
  person_id: string;
  status: EnrichStatus;
  email: string | null;
  email_status: EmailStatus;
  /** Who found the stored address: a finder id, "website", "pattern_guess", or null. */
  provider: string | null;
  credits_used: number;
  /**
   * Why it was skipped, kept, not found or failed, e.g. consent_required, checked_recently,
   * not_found_recently, found_recently, or the failure class (timeout, auth_invalid) for
   * provider_failed.
   */
  reason: string | null;
  /**
   * Compact trail, e.g. ["website:no_match", "hunter:provider_failed", "icypeas:found"].
   * `<finder>:not_found_recently` is a finder skipped because it answered "no match" lately;
   * `<finder>:found_recently` is the finder whose address is on file, skipped while that
   * address was checked within RECHECK_DAYS; `<provider>:not_repeated` is a step an automatic
   * follow-up did not ask again because its failure is not retryable.
   */
  steps: string[];
  /** Provider calls of this run that failed, with the failure. Empty when all answered. */
  failed: EnrichmentFailedStep[];
  /** When the engine asks the failed steps again by itself (set by the job), else null. */
  retry_at: string | null;
}

export interface EnrichPersonOptions {
  mode: EnrichMode;
  /** Allow a verified shared inbox (info@) published on the site as a last resort. */
  allowRoleAddresses?: boolean;
  /**
   * Ask the finders again within RECHECK_DAYS: for a risky or unknown address checked
   * recently, or a person they recently found nothing for.
   */
  force?: boolean;
  /**
   * An automatic follow-up run (the job's retry). A step whose last failure the engine may not
   * repeat by itself (`retryable: false`, for example a paid call that may already have used
   * credits) is not asked again: its failure stays listed (`<provider>:not_repeated`).
   */
  followUp?: boolean;
}

type RecheckFields = Pick<Person, "email" | "email_status" | "email_checked_at" | "enrichment">;

/**
 * True when the last run of a finder failed for this person: the next run asks it again even
 * when the address on file was checked recently or the other finders found nothing lately.
 */
export function finderRetryPending(person: Pick<Person, "enrichment">): boolean {
  return (person.enrichment?.failed ?? []).some((entry) => entry.step === "finder");
}

/** True when a run keeps a risky or unknown address instead of paying the finders again. */
export function keepsCheckedAddress(person: RecheckFields, now: Date, force = false): boolean {
  return (
    !force &&
    !finderRetryPending(person) &&
    Boolean(person.email) &&
    (person.email_status === "risky" || person.email_status === "unknown") &&
    recentlyChecked(person, now)
  );
}

/** True when a run skips the finders because they found nothing for this person recently. */
export function foundNothingRecently(
  person: Pick<Person, "email_not_found_at" | "enrichment">,
  now: Date,
  force = false,
): boolean {
  return !force && !finderRetryPending(person) && withinRecheck(person.email_not_found_at, now);
}

interface Candidate {
  email: string;
  status: EmailStatus;
  provider: string;
  source: string;
}

function withinRecheck(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() < RECHECK_DAYS * 86_400_000;
}

function recentlyChecked(person: Pick<Person, "email_checked_at">, now: Date): boolean {
  return withinRecheck(person.email_checked_at, now);
}

/** Company domain for finding: company.domain, else a non free-mail domain of the email. */
function domainFor(person: Person, company: Company | null): string | null {
  if (company?.domain) return company.domain;
  const fromEmail = emailDomain(person.email);
  return fromEmail && !isFreeMailDomain(fromEmail) ? fromEmail : null;
}

/** True when another person in the workspace already uses this address. */
async function addressTaken(session: EnrichmentSession, personId: string, email: string) {
  const [row] = await session.ctx.db
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.workspace_id, session.workspace.id),
        eq(people.email, email),
        ne(people.id, personId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Bookkeeping fields: saving them alone is not a lead change. */
const CHECK_TIMES = new Set(["email_checked_at", "email_not_found_at"]);

async function savePerson(
  session: EnrichmentSession,
  person: Person,
  patch: Partial<
    Pick<
      Person,
      "email" | "email_status" | "email_source" | "email_checked_at" | "email_not_found_at"
    >
  >,
): Promise<boolean> {
  const changes = Object.keys(patch).filter(
    (key) =>
      !CHECK_TIMES.has(key) &&
      patch[key as keyof typeof patch] !== person[key as keyof typeof patch],
  );
  try {
    await session.ctx.db
      .update(people)
      .set({ ...patch, updated_at: session.ctx.clock.now() })
      .where(and(eq(people.id, person.id), eq(people.workspace_id, session.workspace.id)));
  } catch (error) {
    // Another person got this address meanwhile (unique email per workspace).
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  if (changes.length > 0) {
    await session.ctx.events.emit("lead.updated", {
      subject: { type: "person", id: person.id },
      data: { kind: "person", id: person.id, changes },
    });
  }
  return true;
}

/** What one person's run asked and learned: the trail, the failures and the finder answers. */
class PersonRun {
  readonly steps: string[] = [];
  readonly failed: EnrichmentFailedStep[] = [];
  /** Paid finders that answered this run, with an address or without. */
  readonly answered = new Set<string>();
  /** Paid finders skipped because they answered "no match" recently, with when. */
  readonly remembered = new Map<string, Date>();
  /** Steps this run tried (`finder:<id>`, `verifier`), failed ones included. */
  readonly tried = new Set<string>();
  /** The paid finder whose address is now stored. */
  storedFrom: string | null = null;
  /** The paid finders were not all asked (budget, publication rule, verify only). */
  incomplete = false;

  constructor(
    readonly now: Date,
    readonly previous: PersonEnrichment | null,
  ) {}

  fail(step: EnrichmentFailedStep["step"], label: string, provider: string, failure: Failure) {
    this.steps.push(`${label}:provider_failed`);
    this.failed.push({ step, provider, failure });
  }

  /**
   * True when the finder found the address on file and that address was checked within
   * RECHECK_DAYS: asking it again would pay for the same answer.
   */
  foundRecently(id: string, person: Pick<Person, "email" | "email_checked_at">): boolean {
    const found = this.previous?.found_by;
    return (
      found?.provider === id &&
      person.email !== null &&
      found.email === person.email &&
      withinRecheck(person.email_checked_at, this.now)
    );
  }

  /**
   * The earlier failure of a step (`finder:<id>` or `verifier`) that the engine may not repeat
   * by itself, kept as a failure of this run instead of asking again; null when there is none.
   */
  notRepeated(key: string): EnrichmentFailedStep | null {
    const entry = (this.previous?.failed ?? []).find(
      (item) => stepKey(item) === key && !item.failure.retryable,
    );
    if (!entry) return null;
    this.tried.add(key);
    this.steps.push(`${entry.provider}:not_repeated`);
    this.failed.push(entry);
    return entry;
  }

  /** When the finder last answered "no match", within RECHECK_DAYS. */
  noMatchSince(id: string): Date | null {
    const at = this.previous?.no_match?.[id];
    if (!at) return null;
    const date = new Date(at);
    return withinRecheck(date, this.now) ? date : null;
  }

  /**
   * When the paid finders found nothing: the oldest of their "no match" answers, or null when
   * a step failed or not every finder was asked (the person must be looked for again).
   */
  nothingFoundSince(): Date | null {
    if (this.failed.length > 0 || this.incomplete) return null;
    const answers = [...[...this.answered].map(() => this.now), ...this.remembered.values()];
    if (answers.length === 0) return null;
    return new Date(Math.min(...answers.map((at) => at.getTime())));
  }

  /** The state stored on the person for the next run; `email` is the address now on file. */
  state(status: EnrichStatus, email: string | null): PersonEnrichment {
    const noMatch: Record<string, string> = {};
    for (const [id, at] of Object.entries(this.previous?.no_match ?? {})) {
      if (withinRecheck(new Date(at), this.now)) noMatch[id] = at;
    }
    for (const id of this.answered) noMatch[id] = this.now.toISOString();
    if (this.storedFrom) delete noMatch[this.storedFrom];
    // A run that could not ask everything keeps the earlier failures it did not try again.
    const carried = this.incomplete
      ? (this.previous?.failed ?? []).filter((entry) => !this.tried.has(stepKey(entry)))
      : [];
    // Which paid finder found the address on file, for as long as it stays on file.
    const previous = this.previous?.found_by;
    const foundBy =
      this.storedFrom && email
        ? { provider: this.storedFrom, email, at: this.now.toISOString() }
        : previous && previous.email === email && !this.answered.has(previous.provider)
          ? previous
          : null;
    return {
      at: this.now.toISOString(),
      status,
      ...(Object.keys(noMatch).length > 0 ? { no_match: noMatch } : {}),
      ...(foundBy ? { found_by: foundBy } : {}),
      failed: [...this.failed, ...carried],
      retry_at: null,
    };
  }
}

function stepKey(entry: Pick<EnrichmentFailedStep, "step" | "provider">): string {
  return entry.step === "finder" ? `finder:${entry.provider}` : "verifier";
}

/** Verified status for a candidate, or null when the verifier rejected it. */
async function checkCandidate(
  session: EnrichmentSession,
  candidate: Candidate,
  run: PersonRun,
): Promise<Candidate | null> {
  if (candidate.status === "valid") return candidate;
  const { result, provider, error, failure } = await session.verify(candidate.email);
  if (provider) run.tried.add("verifier");
  if (failure && provider) {
    // Kept with the finder's own status: unverified, and the failure says why.
    run.fail("verifier", provider, provider, failure);
    return candidate;
  }
  if (!result) {
    run.steps.push(`verify:${error ?? "failed"}`);
    return candidate;
  }
  run.steps.push(`${provider}:${result.status}`);
  if (result.status === "invalid") return null;
  return { ...candidate, status: result.status };
}

type Verdict = Partial<Pick<EnrichOutcome, "email" | "email_status" | "provider" | "reason">> & {
  status: EnrichStatus;
};

/**
 * Runs the waterfall for one person and stores what the run did (people.enrichment).
 * `reasons` are the person's email contactability reasons (checkContactableMany), computed
 * in bulk by the caller.
 */
export async function enrichPerson(
  session: EnrichmentSession,
  person: Person,
  company: Company | null,
  reasons: string[],
  options: EnrichPersonOptions,
): Promise<EnrichOutcome> {
  const startCredits = session.creditsUsed;
  const run = new PersonRun(session.ctx.clock.now(), person.enrichment ?? null);
  const verdict = await walk(session, person, company, reasons, options, run);
  if (session.budgetExceeded) run.incomplete = true;
  let { status, reason } = verdict;
  const first = run.failed[0];
  if (first && status === "not_found") {
    status = "provider_failed";
    reason = first.failure.class;
  }
  const outcome: EnrichOutcome = {
    person_id: person.id,
    status,
    email: verdict.email !== undefined ? verdict.email : person.email,
    email_status: verdict.email_status ?? person.email_status,
    provider: verdict.provider ?? null,
    credits_used: session.creditsUsed - startCredits,
    reason: reason ?? null,
    steps: run.steps,
    failed: run.failed,
    retry_at: null,
  };
  await session.ctx.db
    .update(people)
    .set({ enrichment: run.state(status, outcome.email) })
    .where(and(eq(people.id, person.id), eq(people.workspace_id, session.workspace.id)));
  return outcome;
}

/**
 * Stores the run for a person it skipped because the data budget was used up before their
 * turn: the last run is this one (`skipped`), earlier failures stay listed, and no retry is
 * pending any more (the job schedules none once the budget is used up).
 */
export async function storeBudgetSkip(session: EnrichmentSession, person: Person): Promise<void> {
  const run = new PersonRun(session.ctx.clock.now(), person.enrichment ?? null);
  run.incomplete = true;
  await session.ctx.db
    .update(people)
    .set({ enrichment: run.state("skipped", person.email) })
    .where(and(eq(people.id, person.id), eq(people.workspace_id, session.workspace.id)));
}

async function walk(
  session: EnrichmentSession,
  person: Person,
  company: Company | null,
  reasons: string[],
  options: EnrichPersonOptions,
  run: PersonRun,
): Promise<Verdict> {
  const steps = run.steps;
  const now = run.now;

  const blocking = reasons.find((reason) => BLOCKING_REASONS.has(reason));
  if (blocking) return { status: "skipped", reason: blocking };

  // Cold email needs the page that publishes the address (CASL, Spam Act): only the crawler
  // can supply it, for a stored address too.
  const publishedOnly = reasons.includes("publication_evidence_missing");
  if (publishedOnly || options.mode === "verify_only") run.incomplete = true;

  // 1) The existing address (a system address such as noreply@ counts as none).
  let current = person;
  const usable = person.email && !isBlockedRoleAddress(person.email);
  if (usable && person.email) {
    // The last run could not verify it: try that again, unless an automatic follow-up must
    // not repeat that check (it may already have used credits).
    const verifyPending =
      person.email_status === "unknown" &&
      (run.previous?.failed ?? []).some((entry) => entry.step === "verifier");
    const held = verifyPending && options.followUp ? run.notRepeated("verifier") : null;
    if (held && options.mode === "verify_only") {
      return { status: "provider_failed", reason: held.failure.class };
    }
    const shouldVerify =
      !held &&
      (options.mode === "verify_only" ||
        verifyPending ||
        (session.settings.data.enrichment.verify_existing &&
          !(recentlyChecked(person, now) && person.email_status !== "unknown")));
    let verifierFailed: Failure | null = null;
    if (shouldVerify) {
      const { result, provider, error, failure } = await session.verify(person.email);
      if (provider) run.tried.add("verifier");
      if (result) {
        steps.push(`${provider}:${result.status}`);
        await savePerson(session, person, { email_status: result.status, email_checked_at: now });
        current = { ...person, email_status: result.status, email_checked_at: now };
      } else if (failure && provider) {
        run.fail("verifier", provider, provider, failure);
        verifierFailed = failure;
        if (options.mode === "verify_only") {
          return { status: "provider_failed", reason: failure.class };
        }
      } else {
        steps.push(`verify:${error ?? "failed"}`);
        if (options.mode === "verify_only") {
          return { status: "skipped", reason: error ?? "verify_failed" };
        }
      }
    }
    if (options.mode === "verify_only") {
      return { status: "verified", email_status: current.email_status };
    }
    if (
      !publishedOnly &&
      (current.email_status === "valid" || current.email_status === "catch_all")
    ) {
      // A failed re-check keeps the earlier result; the failure is listed.
      if (verifierFailed) {
        return { status: "kept", email_status: current.email_status, reason: verifierFailed.class };
      }
      return { status: shouldVerify ? "verified" : "kept", email_status: current.email_status };
    }
    // Checked before this run, within RECHECK_DAYS: the finders already had their chance.
    if (
      !publishedOnly &&
      keepsCheckedAddress({ ...person, email_status: current.email_status }, now, options.force)
    ) {
      steps.push("finders:checked_recently");
      return { status: "kept", email_status: current.email_status, reason: "checked_recently" };
    }
  } else if (options.mode === "verify_only") {
    return { status: "skipped", reason: person.email ? "role_address" : "no_email" };
  }

  // The paid finders found nothing within RECHECK_DAYS: they are not paid again until then.
  if (!publishedOnly && foundNothingRecently(person, now, options.force)) {
    steps.push("finders:not_found_recently");
    const keeps = usable && current.email_status !== "invalid";
    return {
      status: keeps ? "kept" : "not_found",
      reason: "not_found_recently",
      email_status: current.email_status,
    };
  }

  // 2) Find a (better) address.
  const domain = domainFor(current, company);
  const input = {
    first_name: current.first_name,
    last_name: current.last_name,
    full_name: current.full_name,
    domain,
    company: company?.name ?? null,
    linkedin_url: current.linkedin_url,
  };
  const country = company?.country ?? current.country;
  let found: Candidate | null = null;
  /** The finder skipped because its address is on file and was checked lately. */
  let keptFrom: string | null = null;
  const notFound = async (reason: string | null): Promise<Verdict> => {
    // Only when the finders all answered: a failed or skipped one may still find an address.
    const since = session.budgetExceeded ? null : run.nothingFoundSince();
    if (since) await savePerson(session, current, { email_not_found_at: since });
    return { status: "not_found", reason, email_status: current.email_status };
  };

  for (const id of await session.finderOrder()) {
    if (found) break;
    if (id === WEBSITE_FINDER) {
      const site = await websiteMatch(session, current, company, country);
      steps.push(`website:${site.note}`);
      if (!site.candidate) continue;
      const blocked = await blockedAddressReason(session.ctx, site.candidate.email);
      if (blocked) {
        steps.push(`website:${blocked}`);
        if (blocked !== "role_address") return { status: "skipped", reason: blocked };
        continue;
      }
      // The stored address, published: keep its known status instead of paying to verify it.
      const known =
        site.candidate.email === current.email &&
        current.email_status !== "unknown" &&
        current.email_status !== "invalid";
      found = known
        ? { ...site.candidate, status: current.email_status }
        : await checkCandidate(session, site.candidate, run);
      continue;
    }
    if (publishedOnly) {
      steps.push(`${id}:skipped_needs_published_address`);
      continue;
    }
    // Answered "no match" lately: asked again only after RECHECK_DAYS or with force.
    const noMatch = options.force ? null : run.noMatchSince(id);
    if (noMatch) {
      steps.push(`${id}:not_found_recently`);
      run.remembered.set(id, noMatch);
      continue;
    }
    // Found the address on file, checked lately: it would be paid for again for the same
    // answer. The search ends here, as it did when the finder found it.
    if (!options.force && run.foundRecently(id, current)) {
      steps.push(`${id}:found_recently`);
      if (usable && current.email_status !== "invalid") {
        keptFrom = id;
        break;
      }
      continue;
    }
    // Its last call may already have used credits: a follow-up does not repeat it.
    if (options.followUp && run.notRepeated(`finder:${id}`)) continue;
    const { result, error, failure } = await session.find(id, input);
    if (failure) {
      run.tried.add(`finder:${id}`);
      run.fail("finder", id, id, failure);
      continue;
    }
    if (!result) {
      steps.push(`${id}:${error ?? "failed"}`);
      if (error === "budget_exceeded") break;
      continue;
    }
    run.tried.add(`finder:${id}`);
    run.answered.add(id);
    const email = normalizeEmail(result.email);
    if (!email) {
      steps.push(`${id}:not_found`);
      continue;
    }
    const blocked = await blockedAddressReason(session.ctx, email);
    if (blocked) {
      // A suppressed address (a GDPR erasure too) means this is someone we must not contact.
      steps.push(`${id}:${blocked}`);
      if (blocked !== "role_address") return { status: "skipped", reason: blocked };
      continue;
    }
    steps.push(`${id}:found`);
    found = await checkCandidate(
      session,
      { email, status: result.status ?? "unknown", provider: id, source: id },
      run,
    );
  }

  if (!found && keptFrom) {
    return {
      status: "kept",
      reason: "found_recently",
      email_status: current.email_status,
      provider: keptFrom,
    };
  }

  // 3) Pattern guesses (opt-in) and a verified shared inbox (opt-in per call).
  if (!found && !publishedOnly && domain && session.settings.data.enrichment.pattern_guessing) {
    found = await guessPattern(session, current, domain, run);
  }
  if (!found && options.allowRoleAddresses) {
    found = await roleFallback(session, current, company, country, run);
  }

  if (session.budgetExceeded && !found) return { status: "skipped", reason: "budget_exceeded" };
  if (!found && publishedOnly && usable && current.email_status !== "invalid") {
    // The stored address stays, but no page publishes it: it is not emailed cold.
    return {
      status: "kept",
      reason: "publication_evidence_missing",
      email_status: current.email_status,
    };
  }
  if (!found) return notFound(publishedOnly ? "publication_evidence_missing" : null);
  const blockedFound = await blockedAddressReason(session.ctx, found.email);
  if (blockedFound) {
    steps.push(`store:${blockedFound}`);
    return { status: "skipped", reason: blockedFound };
  }
  if (found.email === current.email) {
    // Found published on the website: the page becomes the evidence (email_source).
    const evidence = found.provider === WEBSITE_FINDER ? { email_source: found.source } : {};
    await savePerson(session, current, {
      email_status: found.status,
      email_checked_at: now,
      email_not_found_at: null,
      ...evidence,
    });
    if (run.answered.has(found.provider)) run.storedFrom = found.provider;
    return { status: "verified", email_status: found.status, provider: found.provider };
  }
  if (await addressTaken(session, current.id, found.email)) {
    steps.push("store:address_used_by_another_person");
    return notFound("email_taken");
  }
  const saved = await savePerson(session, current, {
    email: found.email,
    email_status: found.status,
    email_source: found.source,
    email_checked_at: now,
    email_not_found_at: null,
  });
  if (!saved) return notFound("email_taken");
  if (run.answered.has(found.provider)) run.storedFrom = found.provider;
  return {
    status: "found",
    email: found.email,
    email_status: found.status,
    provider: found.provider,
  };
}

/** Company website for crawling, or a note on why there is none. */
function crawlTarget(
  session: EnrichmentSession,
  company: Company | null,
  country: string | null,
): { website: string | null; note: string } {
  const settings = session.settings.data.enrichment;
  if (!settings.website_crawler) return { website: null, note: "off" };
  if (session.workspace.is_sandbox) return { website: null, note: "sandbox" };
  if (country && settings.crawler_excluded_countries.includes(country)) {
    return { website: null, note: "excluded_country" };
  }
  const website = company?.website ?? company?.domain ?? null;
  return website ? { website, note: "ok" } : { website: null, note: "no_website" };
}

async function websiteMatch(
  session: EnrichmentSession,
  person: Person,
  company: Company | null,
  country: string | null,
): Promise<{ candidate: Candidate | null; note: string }> {
  const target = crawlTarget(session, company, country);
  if (!target.website) return { candidate: null, note: target.note };
  const crawl = await session.crawls.get(target.website);
  if (!crawl || crawl.pages.length === 0) return { candidate: null, note: "unreachable" };
  const match = crawl.emails.find(
    (entry) =>
      entry.kind === "personal" &&
      addressMatchesName(entry.email, person.first_name, person.last_name),
  );
  if (!match) return { candidate: null, note: "no_match" };
  return {
    candidate: {
      email: match.email,
      status: "unknown",
      provider: WEBSITE_FINDER,
      source: match.page_url,
    },
    note: "found",
  };
}

async function guessPattern(
  session: EnrichmentSession,
  person: Person,
  domain: string,
  run: PersonRun,
): Promise<Candidate | null> {
  const steps = run.steps;
  if (isFreeMailDomain(domain)) return null;
  if (!(await session.verifier())) {
    steps.push("pattern:no_verifier");
    return null;
  }
  for (const email of guessAddresses(person.first_name, person.last_name, domain)) {
    if (await blockedAddressReason(session.ctx, email)) {
      steps.push("pattern:suppressed");
      return null;
    }
    const { result, provider, error, failure } = await session.verify(email);
    if (provider) run.tried.add("verifier");
    if (failure && provider) {
      run.fail("verifier", "pattern", provider, failure);
      return null;
    }
    if (!result) {
      steps.push(`pattern:${error ?? "failed"}`);
      return null;
    }
    if (result.status === "valid") {
      steps.push("pattern:found");
      return { email, status: "valid", provider: "pattern_guess", source: "pattern_guess" };
    }
    // A catch-all domain accepts every guess, so a guess proves nothing.
    if (result.status === "catch_all") {
      steps.push("pattern:catch_all_domain");
      return null;
    }
  }
  steps.push("pattern:not_found");
  return null;
}

async function roleFallback(
  session: EnrichmentSession,
  person: Person,
  company: Company | null,
  country: string | null,
  run: PersonRun,
): Promise<Candidate | null> {
  const steps = run.steps;
  const target = crawlTarget(session, company, country);
  if (!target.website) return null;
  const crawl = await session.crawls.get(target.website);
  const role = crawl?.emails.find(
    (entry) => entry.kind === "role" && entry.email.endsWith(`@${crawl.domain}`),
  );
  if (!role) {
    steps.push("role:none_published");
    return null;
  }
  if (await addressTaken(session, person.id, role.email)) {
    steps.push("role:used_by_another_person");
    return null;
  }
  const blocked = await blockedAddressReason(session.ctx, role.email);
  if (blocked) {
    steps.push(`role:${blocked}`);
    return null;
  }
  const { result, provider, error, failure } = await session.verify(role.email);
  if (provider) run.tried.add("verifier");
  if (failure && provider) {
    run.fail("verifier", "role", provider, failure);
    return null;
  }
  if (result?.status !== "valid") {
    steps.push(`role:${result?.status ?? error ?? "unverified"}`);
    return null;
  }
  steps.push("role:found");
  return { email: role.email, status: "valid", provider: WEBSITE_FINDER, source: role.page_url };
}
