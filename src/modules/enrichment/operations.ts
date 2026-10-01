/** Operations of the enrichment module (exposed by the enrich_leads tool). */
import { z } from "zod";
import { budgetHint, budgetWarning, dataBudgetShape, dataBudgetView } from "../../core/budget.js";
import { requireWorkspace } from "../../core/context.js";
import { EMAIL_STATUSES } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import { defineOperation, dryRun, dryRunOutput, jobHandleOutput } from "../../core/operation.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { checkContactableMany } from "../leads/contactable.js";
import { leadFilterSchema, resolvePeople } from "../leads/filters.js";
import { failedStepOutput } from "../leads/operations/shapes.js";
import { loadCompanies, loadPeople } from "../leads/records.js";
import { findCompanyContacts } from "./contacts.js";
import { ENRICH_JOB, FIND_CONTACTS_JOB } from "./jobs.js";
import { runEnrichment } from "./run.js";
import { EnrichmentSession, WEBSITE_FINDER } from "./session.js";
import {
  BLOCKING_REASONS,
  ENRICH_MODES,
  foundNothingRecently,
  keepsCheckedAddress,
  RECHECK_DAYS,
} from "./waterfall.js";

const MAX_ENRICH = 1_000;
const MAX_VERIFY = 25;
const MAX_CONTACT_COMPANIES = 50;
const INLINE_CONTACT_COMPANIES = 3;

// --- enrichment.enrich -------------------------------------------------------------------

const enrichPreview = z.object({
  people: z.number().int(),
  with_email: z.number().int(),
  needs_verification: z.number().int(),
  needs_finding: z.number().int(),
  checked_recently: z
    .number()
    .int()
    .describe(
      "Risky or unknown addresses checked in the last 30 days: kept without spending unless force is true",
    ),
  not_found_recently: z
    .number()
    .int()
    .describe(
      "People the finders found no address for in the last 30 days: skipped without spending unless force is true",
    ),
  blocked: z
    .number()
    .int()
    .describe("People we may not email (suppressed, consent, ...): skipped for free"),
  blocked_by_reason: z.record(z.string(), z.number().int()),
  finders: z.array(z.string()).describe("Waterfall order; website = the free contact crawler"),
  verifier: z.string().nullable(),
  pattern_guessing: z.boolean(),
  budget: dataBudgetShape,
});

export const enrichLeads = defineOperation({
  id: "enrichment.enrich",
  summary: "Find and verify emails for people (background job)",
  description:
    "Runs the enrichment waterfall for people chosen by ids, a list or a filter: verify existing addresses, look for the person's address on the company website, then ask the email finders in the configured order and verify what they return. Use it after importing or finding leads that lack verified emails (people we may never email are skipped for free); use enrich_leads with action verify for a quick check of a few addresses, and find_contacts to discover who works at a company. Run with dry_run first for the counts, finder order and credit upper bound: risky or unknown addresses checked in the last 30 days, and people the finders found nothing for in that time, are not looked up again unless force is true. A finder or verifier that fails makes the person provider_failed with the failed step listed in the job result (never not_found): the job retries temporary failures by itself up to twice, and the next run asks only the failed steps.",
  effect: "spend",
  input: z.object({
    person_ids: z.array(idSchema("pe")).max(MAX_ENRICH).optional().describe("People to enrich"),
    list_id: idSchema("ls").optional().describe("Everyone in this list"),
    filter: leadFilterSchema.optional().describe("People matching this filter"),
    mode: z
      .enum(ENRICH_MODES)
      .default("find_and_verify")
      .describe("find_and_verify (default) or verify_only (only check existing addresses)"),
    allow_role_addresses: z
      .boolean()
      .default(false)
      .describe(
        "Use a verified shared inbox like info@ from the company site when nothing else is found",
      ),
    force: z
      .boolean()
      .default(false)
      .describe(
        "Ask the finders again for people looked up in the last 30 days: a risky or unknown address, or no address found (costs credits)",
      ),
  }),
  output: z.union([
    jobHandleOutput.extend({ people: z.number().int() }),
    dryRunOutput(enrichPreview),
  ]),
  http: { method: "POST", path: "/v1/enrichment/runs" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Enrich a list after an import",
      input: { list_id: "ls_01k6a3v0q8x3m2n4p5r6s7t8w2", mode: "find_and_verify" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (!input.person_ids?.length && !input.list_id && !input.filter) {
      throw new OpenOutboundError("validation_failed", "Say who to enrich.", {
        hint: "Pass person_ids, list_id or filter (for example { has_email: false }).",
      });
    }
    const ids = await resolvePeople(ctx, {
      ...(input.person_ids ? { personIds: input.person_ids } : {}),
      ...(input.list_id ? { listId: input.list_id } : {}),
      ...(input.filter ? { filter: input.filter } : {}),
    });
    if (ids.length > MAX_ENRICH) {
      throw new OpenOutboundError(
        "validation_failed",
        `That selects ${ids.length} people; the limit per run is ${MAX_ENRICH}.`,
        {
          hint: "Narrow the filter (for example min_fit_score or countries) or split the list.",
          details: { people: ids.length, limit: MAX_ENRICH },
        },
      );
    }
    if (ids.length === 0) {
      throw new OpenOutboundError("validation_failed", "No people match that selection.", {
        hint: "Check the ids, list or filter with search_leads.",
      });
    }
    if (ctx.request.dryRun) {
      const settings = parseWorkspaceSettings(workspace.settings);
      const session = new EnrichmentSession(ctx, { operation: "enrichment.enrich" });
      const persons = await loadPeople(ctx, ids);
      const reasons = await checkContactableMany(ctx, ids, "email");
      const now = ctx.clock.now().getTime();
      const budget = await ctx.usage.budgetStatus(workspace.id, "data");
      const preview: z.infer<typeof enrichPreview> = {
        people: persons.length,
        with_email: 0,
        needs_verification: 0,
        needs_finding: 0,
        checked_recently: 0,
        not_found_recently: 0,
        blocked: 0,
        blocked_by_reason: {},
        finders: await session.finderOrder(),
        verifier: (await session.verifier())?.id ?? null,
        pattern_guessing: settings.data.enrichment.pattern_guessing,
        budget: dataBudgetView(budget),
      };
      for (const person of persons) {
        const block = reasons.get(person.id)?.reasons.find((r) => BLOCKING_REASONS.has(r));
        if (block) {
          preview.blocked += 1;
          preview.blocked_by_reason[block] = (preview.blocked_by_reason[block] ?? 0) + 1;
          continue;
        }
        if (person.email) preview.with_email += 1;
        const fresh =
          person.email_checked_at &&
          now - person.email_checked_at.getTime() < RECHECK_DAYS * 86_400_000 &&
          person.email_status !== "unknown";
        if (
          person.email &&
          (input.mode === "verify_only" || settings.data.enrichment.verify_existing) &&
          !fresh
        ) {
          preview.needs_verification += 1;
        }
        if (input.mode === "find_and_verify") {
          if (keepsCheckedAddress(person, ctx.clock.now(), input.force)) {
            preview.checked_recently += 1;
          } else if (
            !person.email ||
            person.email_status === "invalid" ||
            person.email_status === "risky" ||
            person.email_status === "unknown"
          ) {
            if (foundNothingRecently(person, ctx.clock.now(), input.force)) {
              preview.not_found_recently += 1;
            } else {
              preview.needs_finding += 1;
            }
          }
        }
      }
      const paidFinders = preview.finders.filter((id) => id !== WEBSITE_FINDER).length;
      const credits =
        preview.needs_verification + preview.needs_finding * (paidFinders > 0 ? 2 : 1);
      const warnings: string[] = [];
      if (!preview.verifier)
        warnings.push(
          "No email verifier is configured: found addresses stay unverified and are not sent to by default. Add one with manage_providers action set (CLI: `openoutbound providers set --slot email_verifier --provider <id>`).",
        );
      if (input.mode === "find_and_verify" && paidFinders === 0)
        warnings.push(
          "No email finder is configured: only the website crawler will look for addresses.",
        );
      if (preview.checked_recently > 0)
        warnings.push(
          `${preview.checked_recently === 1 ? "1 person has" : `${preview.checked_recently} people have`} a risky or unknown address checked in the last ${RECHECK_DAYS} days: kept without spending. Pass force true to ask the finders again.`,
        );
      if (preview.not_found_recently > 0)
        warnings.push(
          `${preview.not_found_recently === 1 ? "1 person" : `${preview.not_found_recently} people`} had no address found in the last ${RECHECK_DAYS} days: skipped without spending. Pass force true to ask the finders again.`,
        );
      const budgetNote = budgetWarning(budget, credits, {
        outcome: "paid lookups stop when it is used up and the rest are skipped (budget_exceeded)",
        hint: budgetHint(budget, "Enrich fewer people"),
      });
      if (budgetNote) warnings.push(budgetNote);
      return dryRun(preview, {
        warnings,
        estimatedCost: {
          credits,
          note: "Upper bound: finders charge only for found emails and each found email is verified once; people on sites that publish their address cost nothing.",
        },
      });
    }
    const handle = await ctx.jobs.enqueue(ENRICH_JOB, {
      person_ids: ids,
      mode: input.mode,
      allow_role_addresses: input.allow_role_addresses,
      force: input.force,
    });
    return { ...handle, people: ids.length };
  },
});

// --- enrichment.verify -------------------------------------------------------------------

const verifyResult = z.object({
  person_id: z.string(),
  email: z.string().nullable(),
  email_status: z.enum(EMAIL_STATUSES),
  status: z
    .enum(["verified", "kept", "skipped", "found", "not_found", "provider_failed"])
    .describe("provider_failed: the verifier failed, the stored status is unchanged"),
  reason: z.string().nullable().describe("For provider_failed, the failure class"),
  failed: z
    .array(failedStepOutput)
    .describe("The verifier call that failed, with whether trying again later can help"),
});

export const verifyLeads = defineOperation({
  id: "enrichment.verify",
  summary: "Verify the current emails of a few people now",
  description:
    "Checks the stored email addresses of up to 25 people with the configured verifier and saves the result (valid, invalid, catch_all, risky or unknown) with the check time. Use it right before a send decision or after editing an address by hand. It never looks for new addresses: use enrich_leads with action enrich for that, or for more than 25 people. Each check costs one verifier credit (unknown results are usually free); people we may not email are skipped.",
  effect: "spend",
  input: z.object({
    person_ids: z
      .array(idSchema("pe"))
      .min(1)
      .max(MAX_VERIFY)
      .describe("People whose emails to verify"),
  }),
  output: z.union([
    z.object({ items: z.array(verifyResult), credits_used: z.number() }),
    dryRunOutput(
      z.object({
        people: z.number().int(),
        with_email: z.number().int(),
        verifier: z.string().nullable(),
        budget: dataBudgetShape,
      }),
    ),
  ]),
  http: { method: "POST", path: "/v1/enrichment/verify" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    { title: "Verify one address", input: { person_ids: ["pe_01k6a3v0q8x3m2n4p5r6s7t8v9"] } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const ids = [...new Set(input.person_ids)];
    const persons = await loadPeople(ctx, ids);
    if (ctx.request.dryRun) {
      const session = new EnrichmentSession(ctx, { operation: "enrichment.verify" });
      const withEmail = persons.filter((p) => p.email).length;
      const budget = await ctx.usage.budgetStatus(workspace.id, "data");
      const warning = budgetWarning(budget, withEmail, {
        outcome: "checks stop when it is used up and the rest are skipped (budget_exceeded)",
        hint: budgetHint(budget, "Verify fewer people"),
      });
      return dryRun(
        {
          people: persons.length,
          with_email: withEmail,
          verifier: (await session.verifier())?.id ?? null,
          budget: dataBudgetView(budget),
        },
        {
          warnings: warning ? [warning] : [],
          estimatedCost: { credits: withEmail, note: "One verifier credit per address at most." },
        },
      );
    }
    const summary = await runEnrichment(ctx, ids, {
      mode: "verify_only",
      operation: "enrichment.verify",
    });
    const found = new Set(summary.results.map((r) => r.person_id));
    const items = summary.results.map((r) => ({
      person_id: r.person_id,
      email: r.email,
      email_status: r.email_status,
      status: r.status,
      reason: r.reason,
      failed: r.failed,
    }));
    for (const id of ids) {
      if (!found.has(id)) {
        items.push({
          person_id: id,
          email: null,
          email_status: "unknown",
          status: "skipped",
          reason: "person_not_found",
          failed: [],
        });
      }
    }
    return { items, credits_used: summary.credits_used };
  },
});

// --- enrichment.find_contacts ------------------------------------------------------------

const contactPerson = z.object({
  full_name: z.string(),
  title: z.string().nullable(),
  decision_maker: z.boolean(),
  email: z.string().nullable(),
  email_source: z.string().nullable().describe("Page where the address is published"),
  email_status: z.enum(EMAIL_STATUSES).nullable(),
  person_id: z.string().nullable(),
  outcome: z.enum(["created", "updated", "existing", "would_create", "skipped"]),
});

const companyContacts = z.object({
  company_id: z.string(),
  domain: z.string().nullable(),
  status: z.enum(["done", "skipped", "unreachable"]),
  reason: z.string().nullable(),
  filled: z.array(z.string()).describe("Company fields filled from the website"),
  business: z
    .object({
      name: z.string().nullable(),
      address: z.string().nullable(),
      phone: z.string().nullable(),
    })
    .nullable(),
  emails: z.array(
    z.object({ email: z.string(), kind: z.enum(["personal", "role"]), page_url: z.string() }),
  ),
  people: z.array(contactPerson),
  pages: z.array(z.object({ url: z.string(), kind: z.string() })),
  notes: z.array(z.string()),
});

export const findContacts = defineOperation({
  id: "enrichment.find_contacts",
  summary: "Find the people and published emails on company websites",
  description:
    "Crawls each company's own website (home, contact, imprint, team and about pages, robots.txt respected), fills empty company name, address and phone from it, and with one AI call per company lists the people named there, creating decision makers first. Use it for local businesses and companies imported without people (for example from Google Maps). Addresses are attached only when the site publishes them, with the page as email source; a verified info@ style inbox is used only with allow_role_addresses. Not for people you already have: use enrich_leads with action enrich; more than 3 companies run as a background job.",
  effect: "spend",
  input: z.object({
    company_ids: z
      .array(idSchema("co"))
      .min(1)
      .max(MAX_CONTACT_COMPANIES)
      .describe("Companies to crawl"),
    create_people: z
      .boolean()
      .default(true)
      .describe("Create person records (false = only report)"),
    max_people: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("People to keep per company, decision makers first"),
    allow_role_addresses: z
      .boolean()
      .default(false)
      .describe(
        "Use a verified shared inbox like info@ for the first person without a published address",
      ),
  }),
  output: z.union([
    z.object({ items: z.array(companyContacts), credits_used: z.number() }),
    jobHandleOutput.extend({ companies: z.number().int() }),
    dryRunOutput(z.object({ items: z.array(companyContacts) })),
  ]),
  http: { method: "POST", path: "/v1/enrichment/contacts" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Find the owner of a local business",
      input: { company_ids: ["co_01k6a3v0q8x3m2n4p5r6s7t8w1"], max_people: 2 },
    },
  ],
  handler: async (ctx, input) => {
    requireWorkspace(ctx);
    const ids = [...new Set(input.company_ids)];
    if (!ctx.request.dryRun && ids.length > INLINE_CONTACT_COMPANIES) {
      const handle = await ctx.jobs.enqueue(FIND_CONTACTS_JOB, {
        company_ids: ids,
        find_people: true,
        create_people: input.create_people,
        max_people: input.max_people,
        allow_role_addresses: input.allow_role_addresses,
      });
      return { ...handle, companies: ids.length };
    }
    const found = await loadCompanies(ctx, ids);
    const missing = ids.filter((id) => !found.some((company) => company.id === id));
    if (missing.length > 0) {
      throw new OpenOutboundError("not_found", `Company not found: ${missing.join(", ")}.`, {
        hint: "Check the ids with search_leads (action companies).",
        details: { missing },
      });
    }
    const session = new EnrichmentSession(ctx, { operation: "enrichment.find_contacts" });
    const items = [];
    for (const id of ids) {
      const company = found.find((c) => c.id === id);
      if (!company) continue;
      items.push(
        await findCompanyContacts(session, company, {
          apply: !ctx.request.dryRun,
          findPeople: true,
          createPeople: input.create_people,
          maxPeople: input.max_people,
          allowRoleAddresses: input.allow_role_addresses,
        }),
      );
    }
    if (ctx.request.dryRun) {
      return dryRun(
        { items },
        {
          warnings: ["Dry run: pages were read but no AI call, verification or write was made."],
          estimatedCost: {
            credits: 0,
            note: "One fast-tier AI call per crawled company, plus one verifier credit per published address.",
          },
        },
      );
    }
    return { items, credits_used: session.creditsUsed };
  },
});

export const enrichmentOperations = [enrichLeads, verifyLeads, findContacts];
