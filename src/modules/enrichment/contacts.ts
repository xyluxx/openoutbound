/**
 * Company-level website contacts: crawls the company site, fills empty company facts (name,
 * address, phone) from it, and with one brain call lists the people named on the team,
 * imprint and about pages, creating person records for decision makers first. Emails are
 * attached only when the site publishes them (email_source = that page URL); a verified role
 * inbox such as info@ is used only when the caller allows it.
 *
 * This is also how companies imported from Google Maps get their name, address and phone:
 * from the business's own website, never from Google (see google-maps.ts).
 */
import { and, eq } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { EmailStatus } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { describeFailure } from "../../core/failures.js";
import { type Company, companies } from "../../db/schema/index.js";
import { companyBlockReasons } from "../leads/contactable.js";
import { upsertPerson } from "../leads/dedupe.js";
import { buildNames, normalizeEmail } from "../leads/normalize.js";
import { addressMatchesName } from "./addresses.js";
import { blockedAddressReason } from "./blocked.js";
import type { BusinessDetails } from "./business.js";
import type { CrawlSkip, PublishedEmail, SiteCrawl } from "./crawler.js";
import { teamExtractionPrompt } from "./prompts/team.js";
import type { EnrichmentSession } from "./session.js";

export interface CompanyContactsOptions {
  /** Create person records for the people found (else only report them). */
  createPeople: boolean;
  /** People to keep, decision makers first. */
  maxPeople: number;
  /** Use a verified shared inbox (info@) for the first person without a published address. */
  allowRoleAddresses: boolean;
  /** Run the brain on the pages to find named people (one fast-tier call). */
  findPeople: boolean;
  /** false = dry run: crawl and report only (no brain call, no verification, no writes). */
  apply: boolean;
}

export interface ContactPerson {
  full_name: string;
  title: string | null;
  decision_maker: boolean;
  email: string | null;
  email_source: string | null;
  email_status: EmailStatus | null;
  person_id: string | null;
  outcome: "created" | "updated" | "existing" | "would_create" | "skipped";
}

export interface CompanyContactsResult {
  company_id: string;
  domain: string | null;
  status: "done" | "skipped" | "unreachable";
  reason: string | null;
  /** Company fields filled from the website. */
  filled: string[];
  business: Pick<BusinessDetails, "name" | "address" | "phone"> | null;
  emails: PublishedEmail[];
  people: ContactPerson[];
  pages: Array<{ url: string; kind: string }>;
  skipped_pages: CrawlSkip[];
  notes: string[];
}

const TEAM_TEXT_PER_PAGE = 3_500;
const TEAM_TEXT_TOTAL = 10_000;

function blankResult(company: Company): CompanyContactsResult {
  return {
    company_id: company.id,
    domain: company.domain,
    status: "skipped",
    reason: null,
    filled: [],
    business: null,
    emails: [],
    people: [],
    pages: [],
    skipped_pages: [],
    notes: [],
  };
}

/** True while the company name is still the domain placeholder of a Google Maps import. */
export function hasPlaceholderName(company: Pick<Company, "name" | "domain">): boolean {
  const name = company.name.trim().toLowerCase();
  return !name || (company.domain !== null && name === company.domain.toLowerCase());
}

/** Company patch from the site's business facts: fills empty fields and the domain placeholder. */
export function businessPatch(
  company: Company,
  business: BusinessDetails,
): Partial<
  Pick<Company, "name" | "address" | "city" | "postal_code" | "region" | "country" | "phone">
> {
  const patch: Partial<
    Pick<Company, "name" | "address" | "city" | "postal_code" | "region" | "country" | "phone">
  > = {};
  if (business.name && hasPlaceholderName(company)) patch.name = business.name;
  for (const key of ["address", "city", "postal_code", "region", "country", "phone"] as const) {
    if (!company[key] && business[key]) patch[key] = business[key];
  }
  return patch;
}

function crawlTarget(
  session: EnrichmentSession,
  company: Company,
): { website: string | null; reason: string | null } {
  const settings = session.settings.data.enrichment;
  if (!settings.website_crawler) return { website: null, reason: "website_crawler_off" };
  if (session.workspace.is_sandbox) return { website: null, reason: "sandbox_no_web" };
  if (company.country && settings.crawler_excluded_countries.includes(company.country)) {
    return { website: null, reason: "crawler_excluded_country" };
  }
  const website = company.website ?? company.domain;
  return website ? { website, reason: null } : { website: null, reason: "no_website" };
}

async function teamMembers(
  session: EnrichmentSession,
  company: Company,
  crawl: SiteCrawl,
  notes: string[],
) {
  const order = ["team", "imprint", "about", "contact", "home"];
  const pages = [...crawl.pages].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  let budget = TEAM_TEXT_TOTAL;
  const selected: Array<{ url: string; kind: string; text: string }> = [];
  for (const page of pages) {
    if (budget <= 0) break;
    const text = page.text.slice(0, Math.min(TEAM_TEXT_PER_PAGE, budget));
    if (!text.trim()) continue;
    selected.push({ url: page.url, kind: page.kind, text });
    budget -= text.length;
  }
  if (selected.length === 0) return [];
  try {
    const { output } = await session.ctx.brain.run(teamExtractionPrompt, {
      company: company.name,
      domain: crawl.domain,
      pages: selected,
    });
    return [...output.people].sort((a, b) => Number(b.decision_maker) - Number(a.decision_maker));
  } catch (error) {
    if (error instanceof OpenOutboundError && error.code === "budget_exceeded") {
      notes.push("ai_budget_exceeded: people were not extracted");
      return [];
    }
    throw error;
  }
}

/** Crawls one company's site and applies what it finds (see file comment). */
export async function findCompanyContacts(
  session: EnrichmentSession,
  company: Company,
  options: CompanyContactsOptions,
): Promise<CompanyContactsResult> {
  const ctx: OpContext = session.ctx;
  const result = blankResult(company);
  const blocked = await companyBlockReasons(ctx, company);
  if (blocked.length > 0) {
    result.reason = blocked[0] ?? null;
    return result;
  }
  const target = crawlTarget(session, company);
  if (!target.website) {
    result.reason = target.reason;
    return result;
  }
  const crawl = await session.crawls.get(target.website);
  if (!crawl || crawl.pages.length === 0) {
    result.status = "unreachable";
    result.reason = crawl?.skipped[0]?.reason ?? "fetch_failed";
    result.skipped_pages = crawl?.skipped ?? [];
    return result;
  }
  result.status = "done";
  result.pages = crawl.pages.map((page) => ({ url: page.url, kind: page.kind }));
  result.skipped_pages = crawl.skipped;
  result.emails = crawl.emails;
  result.business = {
    name: crawl.business.name,
    address: crawl.business.address,
    phone: crawl.business.phone,
  };

  // Company facts from the site.
  const patch = businessPatch(company, crawl.business);
  result.filled = Object.keys(patch);
  let current = company;
  if (options.apply && result.filled.length > 0) {
    const [updated] = await ctx.db
      .update(companies)
      .set({ ...patch, updated_at: ctx.clock.now() })
      .where(and(eq(companies.id, company.id), eq(companies.workspace_id, session.workspace.id)))
      .returning();
    if (updated) current = updated;
    await ctx.events.emit("lead.updated", {
      subject: { type: "company", id: company.id },
      data: { kind: "company", id: company.id, changes: result.filled },
    });
  }

  if (!options.findPeople) return result;
  if (!options.apply) {
    result.notes.push("People are extracted when this runs for real (one AI call per company).");
    return result;
  }

  const published = new Map(crawl.emails.map((entry) => [entry.email, entry]));
  const members = (await teamMembers(session, current, crawl, result.notes)).slice(
    0,
    options.maxPeople,
  );
  let roleUsed = false;
  for (const member of members) {
    // Only addresses the site really publishes; the model's copy must match one of them.
    const claimed = normalizeEmail(member.email);
    const claimedEntry = claimed ? published.get(claimed) : undefined;
    const [first, last] = firstLast(member.full_name);
    let email: PublishedEmail | undefined =
      claimedEntry?.kind === "personal"
        ? claimedEntry
        : crawl.emails.find(
            (entry) => entry.kind === "personal" && addressMatchesName(entry.email, first, last),
          );
    const blocked = email ? await blockedAddressReason(ctx, email.email) : null;
    if (blocked && blocked !== "role_address") {
      // Suppressed or erased (GDPR forget): never re-create this person from the site.
      result.notes.push(`one person was not added: their published address is ${blocked}`);
      continue;
    }
    if (blocked) email = undefined;
    let status: EmailStatus | null = null;
    if (!email && options.allowRoleAddresses && !roleUsed) {
      const role =
        (claimedEntry?.kind === "role" ? claimedEntry : undefined) ??
        crawl.emails.find(
          (entry) => entry.kind === "role" && entry.email.endsWith(`@${crawl.domain}`),
        );
      if (role && (await blockedAddressReason(ctx, role.email))) {
        result.notes.push(`role address ${role.email} not used: blocked`);
      } else if (role) {
        const check = await session.verify(role.email);
        if (check.result?.status === "valid") {
          email = role;
          status = "valid";
          roleUsed = true;
        } else {
          const why = check.failure
            ? `the verifier failed (${describeFailure(check.failure)})`
            : (check.result?.status ?? check.error ?? "unverified");
          result.notes.push(`role address ${role.email} not used: ${why}`);
        }
      }
    }
    if (email && !status) {
      const check = await session.verify(email.email);
      status = check.result?.status ?? "unknown";
      if (status === "invalid") email = undefined;
      if (check.failure) {
        result.notes.push(
          `${email?.email ?? "address"} kept unverified: the verifier failed (${describeFailure(check.failure)})`,
        );
      }
    }
    const entry: ContactPerson = {
      full_name: member.full_name,
      title: member.title,
      decision_maker: member.decision_maker,
      email: email?.email ?? null,
      email_source: email?.page_url ?? null,
      email_status: email ? status : null,
      person_id: null,
      outcome: "skipped",
    };
    if (!options.createPeople) {
      entry.outcome = "would_create";
      result.people.push(entry);
      continue;
    }
    const names = buildNames({ full_name: member.full_name });
    const { person, outcome } = await upsertPerson(
      ctx,
      {
        ...names,
        title: member.title,
        email: entry.email,
        email_status: entry.email ? (status ?? "unknown") : null,
        email_source: entry.email_source,
        email_checked_at: entry.email && status && status !== "unknown" ? ctx.clock.now() : null,
        country: current.country,
        city: current.city,
        source: "website",
        tags: member.decision_maker ? ["decision_maker"] : [],
      },
      { policy: "fill_empty", apply: true, company: current },
    );
    entry.person_id = person?.id ?? null;
    entry.outcome =
      outcome === "created" ? "created" : outcome === "unchanged" ? "existing" : "updated";
    result.people.push(entry);
  }
  return result;
}

function firstLast(fullName: string): [string | null, string | null] {
  const names = buildNames({ full_name: fullName });
  return [names.first_name ?? null, names.last_name ?? null];
}
