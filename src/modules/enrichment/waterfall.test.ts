import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailStatus } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { type Company, type Person, people, suppressions } from "../../db/schema/index.js";
import type {
  EmailFinderProvider,
  EmailVerifierProvider,
  FindEmailInput,
  FindEmailResult,
} from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { truncateAll } from "../../testing/db.js";
import { seedCompany, seedPerson, seedWorkspace } from "../../testing/factories.js";
import { addSuppression, checkContactable } from "../leads/service.js";
import { hashSuppressionValue } from "../leads/suppressions.js";
import { enrichJob } from "./jobs.js";
import { runEnrichment } from "./run.js";
import { requestEnrichment, verifyEmailNow } from "./service.js";
import { EnrichmentSession } from "./session.js";
import { type EnrichPersonOptions, enrichPerson } from "./waterfall.js";

// Websites use the reserved .test TLD: the email extractor drops example.* addresses.
const SITE = "https://brightsmile.test";

interface FakeFinder {
  provider: EmailFinderProvider;
  calls: FindEmailInput[];
}

function finder(
  id: string,
  answer: Partial<FindEmailResult> | ((input: FindEmailInput) => FindEmailResult),
): FakeFinder {
  const calls: FindEmailInput[] = [];
  return {
    calls,
    provider: {
      id,
      async findEmail(input) {
        calls.push(input);
        if (typeof answer === "function") return answer(input);
        return { email: null, creditsUsed: answer.email ? 1 : 0, ...answer };
      },
    },
  };
}

function verifier(statuses: Record<string, EmailStatus> = {}, fallback: EmailStatus = "valid") {
  const calls: string[] = [];
  const provider: EmailVerifierProvider = {
    id: "fakeverify",
    async verify(email) {
      calls.push(email);
      const status = statuses[email] ?? fallback;
      return { email, status, creditsUsed: status === "unknown" ? 0 : 1 };
    },
  };
  return { provider, calls };
}

let ctx: TestContext;
let company: Company;
let person: Person;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function setup(
  settings: Record<string, unknown> = {},
  over: Partial<Person> = {},
  companyOver: Partial<Company> = {},
) {
  await truncateAll(ctx.db);
  const workspace = await seedWorkspace(ctx.db, { settings });
  ctx = ctx.with({ workspace });
  for (const list of [ctx.recorded.events, ctx.recorded.usage, ctx.recorded.jobs]) list.length = 0;
  ctx.providers.set("email_finder", null);
  ctx.providers.set("email_verifier", null);
  ctx.usage.setOverBudget("data", false);
  company = await seedCompany(ctx, {
    name: "Brightsmile Dental Studio",
    domain: "brightsmile.test",
    website: SITE,
    country: "US",
    ...companyOver,
  });
  person = await seedPerson(ctx, {
    company_id: company.id,
    first_name: "Dana",
    last_name: "Rivers",
    full_name: "Dana Rivers",
    email: null,
    email_status: "unknown",
    country: "US",
    ...over,
  });
}

function site(pages: Record<string, string>) {
  for (const [path, body] of Object.entries(pages)) ctx.fetch.route(`${SITE}${path}`, { body });
  // Everything else on the site does not exist.
  ctx.fetch.route(/^https:\/\/brightsmile\.test\/.+/, (request) =>
    pages[new URL(request.url).pathname] !== undefined
      ? { body: pages[new URL(request.url).pathname] }
      : { status: 404, body: "" },
  );
}

async function enrich(options: Partial<EnrichPersonOptions> = {}) {
  const session = new EnrichmentSession(ctx, { operation: "test.enrich" });
  const fresh = (await ctx.db.select().from(people).where(eq(people.id, person.id)))[0] as Person;
  const reasons = (await checkContactable(ctx, { personId: person.id, channel: "email" })).reasons;
  const outcome = await enrichPerson(session, fresh, company, reasons, {
    mode: "find_and_verify",
    ...options,
  });
  const stored = (await ctx.db.select().from(people).where(eq(people.id, person.id)))[0] as Person;
  return { outcome, stored, session };
}

describe("finder order", () => {
  beforeEach(async () => {
    await setup({ data: { enrichment: { finders: ["hunter", "icypeas"] } } });
    site({ "/": "<html><body><a href='mailto:info@brightsmile.test'>Mail</a></body></html>" });
  });

  it("tries the website, then finders in the configured order, and verifies the result", async () => {
    const hunter = finder("hunter", {});
    const icypeas = finder("icypeas", { email: "Dana.Rivers@brightsmile.test", status: "risky" });
    const check = verifier();
    ctx.providers.set("email_finder", [icypeas.provider, hunter.provider]);
    ctx.providers.set("email_verifier", check.provider);

    const { outcome, stored } = await enrich();
    expect(outcome).toMatchObject({
      status: "found",
      email: "dana.rivers@brightsmile.test",
      email_status: "valid",
      provider: "icypeas",
      credits_used: 2,
    });
    expect(outcome.steps).toEqual([
      "website:no_match",
      "hunter:not_found",
      "icypeas:found",
      "fakeverify:valid",
    ]);
    expect(hunter.calls[0]).toMatchObject({
      first_name: "Dana",
      last_name: "Rivers",
      domain: "brightsmile.test",
    });
    expect(stored).toMatchObject({
      email: "dana.rivers@brightsmile.test",
      email_status: "valid",
      email_source: "icypeas",
    });
    expect(stored.email_checked_at).toBeInstanceOf(Date);
    expect(ctx.recorded.usage.map((u) => [u.slot, u.provider, u.credits])).toEqual([
      ["email_finder", "icypeas", 1],
      ["email_verifier", "fakeverify", 1],
    ]);
    expect(ctx.emitted("lead.updated")[0]?.data).toMatchObject({
      changes: expect.arrayContaining(["email", "email_status", "email_source"]),
    });
  });

  it("uses every enabled finder when none are configured, website first", async () => {
    await setup();
    site({ "/": "<html><body>Nothing</body></html>" });
    const first = finder("findymail", {});
    const second = finder("prospeo", { email: "dana@brightsmile.test", status: "valid" });
    ctx.providers.set("email_finder", [first.provider, second.provider]);
    const { outcome } = await enrich();
    expect(outcome.steps).toEqual(["website:no_match", "findymail:not_found", "prospeo:found"]);
    // A finder that reports valid is trusted; no verifier is configured anyway.
    expect(outcome).toMatchObject({ status: "found", email_status: "valid" });
  });

  it("notes provider failures and moves on", async () => {
    const broken = finder("hunter", () => {
      throw new OpenOutboundError("provider_error", "Hunter rejected the API key", {
        details: { auth: true },
      });
    });
    const working = finder("icypeas", { email: "dana@brightsmile.test", status: "valid" });
    ctx.providers.set("email_finder", [broken.provider, working.provider]);
    const { outcome } = await enrich();
    expect(outcome.steps).toContain("hunter:provider_failed");
    expect(outcome).toMatchObject({
      status: "found",
      failed: [{ step: "finder", provider: "hunter" }],
    });
  });

  it("skips finders that are not configured", async () => {
    const { outcome } = await enrich();
    expect(outcome).toMatchObject({ status: "not_found", credits_used: 0 });
    expect(outcome.steps).toEqual([
      "website:no_match",
      "hunter:not_configured",
      "icypeas:not_configured",
    ]);
  });
});

describe("website crawler", () => {
  it("prefers the address the company publishes and records the page as source", async () => {
    await setup();
    site({
      "/": "<html><body><a href='/kontakt'>Kontakt</a></body></html>",
      "/kontakt": "<p>Dr. Dana Rivers: d.rivers [at] brightsmile [dot] test</p>",
    });
    const paid = finder("hunter", { email: "other@brightsmile.test" });
    const check = verifier();
    ctx.providers.set("email_finder", paid.provider);
    ctx.providers.set("email_verifier", check.provider);
    const { outcome, stored } = await enrich();
    expect(outcome).toMatchObject({
      status: "found",
      provider: "website",
      email: "d.rivers@brightsmile.test",
    });
    expect(stored.email_source).toBe(`${SITE}/kontakt`);
    expect(paid.calls).toHaveLength(0);
    expect(check.calls).toEqual(["d.rivers@brightsmile.test"]);
  });

  it("can be turned off and never crawls excluded countries", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    const off = await enrich();
    expect(off.outcome.steps).toEqual([]);

    await setup(
      { data: { enrichment: { crawler_excluded_countries: ["NZ"] } } },
      { country: "NZ" },
      { country: "NZ" },
    );
    const before = ctx.recorded.fetch.length;
    const excluded = await enrich();
    expect(excluded.outcome.steps).toEqual(["website:excluded_country"]);
    expect(ctx.recorded.fetch.length).toBe(before);
  });

  it("enriches people in Australia from the page that publishes their address", async () => {
    await setup({}, { country: "AU" }, { country: "AU" });
    site({
      "/": "<html><body><a href='/team'>Team</a></body></html>",
      "/team": "<p>Practice manager Dana Rivers: dana.rivers@brightsmile.test</p>",
    });
    const paid = finder("hunter", { email: "other@brightsmile.test" });
    const check = verifier();
    ctx.providers.set("email_finder", paid.provider);
    ctx.providers.set("email_verifier", check.provider);
    const before = await checkContactable(ctx, { personId: person.id, channel: "email" });
    expect(before.reasons).toContain("publication_evidence_missing");

    const { outcome, stored } = await enrich();
    expect(outcome).toMatchObject({
      status: "found",
      provider: "website",
      email: "dana.rivers@brightsmile.test",
      email_status: "valid",
    });
    expect(stored.email_source).toBe(`${SITE}/team`);
    expect(outcome.steps).toEqual(["website:found", "fakeverify:valid"]);
    expect(paid.calls).toHaveLength(0);
    const after = await checkContactable(ctx, { personId: person.id, channel: "email" });
    expect(after.reasons).not.toContain("publication_evidence_missing");
  });

  it("records the page for a stored address it finds published, without verifying it again", async () => {
    await setup(
      {},
      {
        country: "AU",
        email: "dana.rivers@brightsmile.test",
        email_status: "valid",
        email_source: "apollo",
        email_checked_at: new Date(ctx.clock.now().getTime() - 86_400_000),
      },
      { country: "AU" },
    );
    const check = verifier();
    ctx.providers.set("email_verifier", check.provider);

    site({ "/": "<html><body>No people listed here.</body></html>" });
    const unpublished = await enrich();
    expect(unpublished.outcome).toMatchObject({
      status: "kept",
      reason: "publication_evidence_missing",
      credits_used: 0,
    });
    expect(unpublished.stored.email_source).toBe("apollo");

    site({ "/": "<p>Contact Dana Rivers at dana.rivers@brightsmile.test</p>" });
    const published = await enrich();
    expect(published.outcome).toMatchObject({
      status: "verified",
      provider: "website",
      email_status: "valid",
      credits_used: 0,
    });
    expect(published.stored.email_source).toBe(`${SITE}/`);
    expect(check.calls).toHaveLength(0);
    const after = await checkContactable(ctx, { personId: person.id, channel: "email" });
    expect(after.reasons).not.toContain("publication_evidence_missing");
  });
});

describe("compliance", () => {
  it("skips people we may not email without spending", async () => {
    await setup({}, { country: "DE" });
    const paid = finder("hunter", { email: "dana@brightsmile.test" });
    ctx.providers.set("email_finder", paid.provider);
    const { outcome } = await enrich();
    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "consent_required",
      credits_used: 0,
    });
    expect(paid.calls).toHaveLength(0);

    await setup();
    await addSuppression(ctx, {
      type: "domain",
      value: "brightsmile.test",
      reason: "manual",
      source: "test",
    });
    ctx.providers.set("email_finder", paid.provider);
    expect((await enrich()).outcome).toMatchObject({
      status: "skipped",
      reason: "suppressed_domain",
    });
  });

  it("only accepts a published address where cold email needs publication evidence", async () => {
    await setup({}, { country: "CA" }, { country: "CA" });
    site({ "/": "<html><body>No addresses</body></html>" });
    const paid = finder("hunter", { email: "dana@brightsmile.test" });
    ctx.providers.set("email_finder", paid.provider);
    const { outcome } = await enrich();
    expect(outcome).toMatchObject({ status: "not_found", reason: "publication_evidence_missing" });
    expect(outcome.steps).toEqual(["website:no_match", "hunter:skipped_needs_published_address"]);
    expect(paid.calls).toHaveLength(0);
  });
});

describe("existing addresses", () => {
  it("verifies an existing address and stops when it is valid", async () => {
    await setup({}, { email: "dana@brightsmile.test", email_status: "unknown" });
    const check = verifier();
    const paid = finder("hunter", { email: "x@brightsmile.test" });
    ctx.providers.set("email_verifier", check.provider);
    ctx.providers.set("email_finder", paid.provider);
    const { outcome, stored } = await enrich();
    expect(outcome).toMatchObject({ status: "verified", email_status: "valid" });
    expect(stored.email_status).toBe("valid");
    expect(paid.calls).toHaveLength(0);
  });

  it("keeps a recently verified address without spending", async () => {
    await setup(
      {},
      {
        email: "dana@brightsmile.test",
        email_status: "valid",
        email_checked_at: new Date("2026-09-10T00:00:00Z"),
      },
    );
    const check = verifier();
    ctx.providers.set("email_verifier", check.provider);
    expect((await enrich()).outcome).toMatchObject({ status: "kept", credits_used: 0 });
    expect(check.calls).toHaveLength(0);
  });

  it("keeps a risky or unknown address checked in the last 30 days instead of paying again", async () => {
    const daysAgo = (days: number) => new Date(ctx.clock.now().getTime() - days * 86_400_000);
    await setup(
      { data: { enrichment: { website_crawler: false } } },
      { email: "dana@brightsmile.test", email_status: "risky", email_checked_at: daysAgo(5) },
    );
    const check = verifier({}, "risky");
    const paid = finder("hunter", { email: "d.rivers@brightsmile.test", status: "risky" });
    ctx.providers.set("email_verifier", check.provider);
    ctx.providers.set("email_finder", paid.provider);

    const kept = await enrich();
    expect(kept.outcome).toMatchObject({
      status: "kept",
      reason: "checked_recently",
      email: "dana@brightsmile.test",
      email_status: "risky",
      credits_used: 0,
      steps: ["finders:checked_recently"],
    });
    expect(paid.calls).toHaveLength(0);
    expect(check.calls).toHaveLength(0);

    // The caller forces it: the finders are asked again.
    const forced = await enrich({ force: true });
    expect(forced.outcome.steps).toContain("hunter:found");
    expect(paid.calls).toHaveLength(1);

    // An unknown address is re-verified (usually free) but still not looked for again.
    await ctx.db
      .update(people)
      .set({
        email: "dana@brightsmile.test",
        email_status: "unknown",
        email_checked_at: daysAgo(5),
      })
      .where(eq(people.id, person.id));
    ctx.providers.set("email_verifier", verifier({}, "unknown").provider);
    const unknown = await enrich();
    expect(unknown.outcome).toMatchObject({ status: "kept", reason: "checked_recently" });
    expect(paid.calls).toHaveLength(1);

    // A stale check (over 30 days) looks again.
    await ctx.db
      .update(people)
      .set({ email_status: "risky", email_checked_at: daysAgo(31) })
      .where(eq(people.id, person.id));
    const stale = await enrich();
    expect(stale.outcome.steps).toContain("hunter:found");
    expect(paid.calls).toHaveLength(2);
  });

  it("replaces an invalid address with a verified one", async () => {
    await setup({}, { email: "old@brightsmile.test", email_status: "unknown" });
    site({ "/": "<html></html>" });
    ctx.providers.set("email_verifier", verifier({ "old@brightsmile.test": "invalid" }).provider);
    ctx.providers.set(
      "email_finder",
      finder("hunter", { email: "dana@brightsmile.test" }).provider,
    );
    const { outcome, stored } = await enrich();
    expect(outcome.steps).toEqual([
      "fakeverify:invalid",
      "website:no_match",
      "hunter:found",
      "fakeverify:valid",
    ]);
    expect(stored).toMatchObject({
      email: "dana@brightsmile.test",
      email_status: "valid",
      email_source: "hunter",
    });
  });
});

describe("people the finders found nothing for", () => {
  const daysAgo = (days: number) => new Date(ctx.clock.now().getTime() - days * 86_400_000);

  it("remembers when the finders found nothing and waits 30 days before paying them again", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    const paid = finder("hunter", { email: null });
    ctx.providers.set("email_finder", paid.provider);

    const first = await enrich();
    expect(first.outcome).toMatchObject({ status: "not_found", reason: null });
    expect(first.outcome.steps).toEqual(["hunter:not_found"]);
    expect(first.stored.email_not_found_at).toEqual(ctx.clock.now());
    expect(paid.calls).toHaveLength(1);

    const again = await enrich();
    expect(again.outcome).toMatchObject({
      status: "not_found",
      reason: "not_found_recently",
      email: null,
      credits_used: 0,
      steps: ["finders:not_found_recently"],
    });
    expect(paid.calls).toHaveLength(1);

    // The caller forces it: the finders are asked again.
    const forced = await enrich({ force: true });
    expect(forced.outcome.steps).toEqual(["hunter:not_found"]);
    expect(paid.calls).toHaveLength(2);

    // Found nothing 31 days ago: they are asked again.
    ctx.clock.advance(31 * 86_400_000);
    await enrich();
    expect(paid.calls).toHaveLength(3);
  });

  it("forgets it once an address is found", async () => {
    await setup(
      { data: { enrichment: { website_crawler: false } } },
      { email_not_found_at: daysAgo(40) },
    );
    ctx.providers.set(
      "email_finder",
      finder("hunter", { email: "dana@brightsmile.test", status: "valid" }).provider,
    );
    const { outcome, stored } = await enrich();
    expect(outcome.status).toBe("found");
    expect(stored.email_not_found_at).toBeNull();
  });

  it("waits the same way for an invalid address on file", async () => {
    await setup(
      { data: { enrichment: { website_crawler: false } } },
      {
        email: "old@brightsmile.test",
        email_status: "invalid",
        email_checked_at: daysAgo(2),
        email_not_found_at: daysAgo(2),
      },
    );
    const paid = finder("hunter", { email: "dana@brightsmile.test" });
    ctx.providers.set("email_finder", paid.provider);
    const { outcome } = await enrich();
    expect(outcome).toMatchObject({
      status: "not_found",
      reason: "not_found_recently",
      email: "old@brightsmile.test",
      email_status: "invalid",
    });
    expect(paid.calls).toHaveLength(0);
  });

  it("keeps a usable address on file instead of paying the finders again", async () => {
    await setup(
      { data: { enrichment: { website_crawler: false } } },
      { email: "dana@brightsmile.test", email_status: "unknown", email_not_found_at: daysAgo(4) },
    );
    ctx.providers.set("email_verifier", verifier({}, "risky").provider);
    const paid = finder("hunter", { email: "d.rivers@brightsmile.test" });
    ctx.providers.set("email_finder", paid.provider);
    const { outcome, stored } = await enrich();
    expect(outcome).toMatchObject({
      status: "kept",
      reason: "not_found_recently",
      email: "dana@brightsmile.test",
      email_status: "risky",
      steps: ["fakeverify:risky", "finders:not_found_recently"],
    });
    expect(stored.email_status).toBe("risky");
    expect(paid.calls).toHaveLength(0);
  });

  it("marks nothing when no paid finder answered", async () => {
    // Only the free website crawler runs.
    await setup();
    site({ "/": "<html><body>Nothing</body></html>" });
    expect((await enrich()).stored.email_not_found_at).toBeNull();

    // The finder failed: it never looked, so the person is not marked and is looked for again.
    const broken = finder("hunter", () => {
      throw new OpenOutboundError("provider_error", "Hunter is down", { details: {} });
    });
    ctx.providers.set("email_finder", broken.provider);
    const failed = await enrich();
    expect(failed.outcome).toMatchObject({
      status: "provider_failed",
      steps: expect.arrayContaining(["hunter:provider_failed"]),
    });
    expect(failed.stored.email_not_found_at).toBeNull();

    // Out of budget: skipped, not searched.
    ctx.providers.set("email_finder", finder("hunter", { email: null }).provider);
    ctx.usage.setOverBudget("data");
    const skipped = await enrich();
    expect(skipped.outcome).toMatchObject({ status: "skipped", reason: "budget_exceeded" });
    expect(skipped.stored.email_not_found_at).toBeNull();
  });

  it("still crawls for people who need a published address", async () => {
    await setup({}, { country: "AU", email_not_found_at: daysAgo(3) }, { country: "AU" });
    site({
      "/": "<html><body><a href='/team'>Team</a></body></html>",
      "/team": "<p>Practice manager Dana Rivers: dana.rivers@brightsmile.test</p>",
    });
    const { outcome } = await enrich();
    expect(outcome).toMatchObject({ status: "found", provider: "website" });
  });
});

describe("catch-all, guesses and role addresses", () => {
  it("stops at a catch-all result instead of paying the next finder", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    const first = finder("hunter", { email: "dana@brightsmile.test", status: "unknown" });
    const second = finder("icypeas", { email: "d.rivers@brightsmile.test" });
    ctx.providers.set("email_finder", [first.provider, second.provider]);
    ctx.providers.set("email_verifier", verifier({}, "catch_all").provider);
    const { outcome } = await enrich();
    expect(outcome).toMatchObject({ status: "found", email_status: "catch_all" });
    expect(second.calls).toHaveLength(0);
  });

  it("drops invalid finder results and tries the next finder", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    ctx.providers.set("email_finder", [
      finder("hunter", { email: "bad@brightsmile.test" }).provider,
      finder("icypeas", { email: "dana@brightsmile.test" }).provider,
    ]);
    ctx.providers.set("email_verifier", verifier({ "bad@brightsmile.test": "invalid" }).provider);
    const { outcome } = await enrich();
    expect(outcome.steps).toEqual([
      "hunter:found",
      "fakeverify:invalid",
      "icypeas:found",
      "fakeverify:valid",
    ]);
    expect(outcome.email).toBe("dana@brightsmile.test");
  });

  it("guesses patterns only when enabled, and never on catch-all domains", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    const check = verifier({ "dana.rivers@brightsmile.test": "invalid" }, "valid");
    ctx.providers.set("email_verifier", check.provider);
    expect((await enrich()).outcome.status).toBe("not_found");
    expect(check.calls).toHaveLength(0);

    await setup({ data: { enrichment: { website_crawler: false, pattern_guessing: true } } });
    ctx.providers.set("email_verifier", check.provider);
    const { outcome, stored } = await enrich();
    expect(outcome.steps).toEqual(["pattern:found"]);
    expect(stored).toMatchObject({ email: "dana@brightsmile.test", email_source: "pattern_guess" });

    await setup({ data: { enrichment: { website_crawler: false, pattern_guessing: true } } });
    ctx.providers.set("email_verifier", verifier({}, "catch_all").provider);
    expect((await enrich()).outcome).toMatchObject({
      status: "not_found",
      steps: ["pattern:catch_all_domain"],
    });
  });

  it("uses a verified role inbox only when allowed", async () => {
    await setup();
    site({ "/": "<html><body><a href='mailto:info@brightsmile.test'>Mail</a></body></html>" });
    ctx.providers.set("email_verifier", verifier().provider);
    expect((await enrich()).outcome.status).toBe("not_found");
    const { outcome, stored } = await enrich({ allowRoleAddresses: true });
    expect(outcome).toMatchObject({ status: "found", email: "info@brightsmile.test" });
    expect(stored.email_source).toBe(`${SITE}/`);
  });

  it("never takes an address another person already has", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    await seedPerson(ctx, { email: "dana@brightsmile.test", company_id: company.id });
    ctx.providers.set(
      "email_finder",
      finder("hunter", { email: "dana@brightsmile.test", status: "valid" }).provider,
    );
    const { outcome, stored } = await enrich();
    expect(outcome).toMatchObject({ status: "not_found", reason: "email_taken" });
    expect(stored.email).toBeNull();
  });
});

describe("blocked addresses", () => {
  it("never verifies or stores an address a GDPR forget erased", async () => {
    await setup();
    site({ "/": "<html><body>Nothing</body></html>" });
    await ctx.db.insert(suppressions).values({
      workspace_id: ctx.workspace.id,
      type: "email",
      value: hashSuppressionValue("dana@brightsmile.test"),
      reason: "gdpr_erasure",
    });
    const erased = finder("icypeas", { email: "Dana@Brightsmile.test", status: "risky" });
    const next = finder("hunter", { email: "d.rivers@brightsmile.test", status: "valid" });
    const check = verifier();
    ctx.providers.set("email_finder", [erased.provider, next.provider]);
    ctx.providers.set("email_verifier", check.provider);

    const { outcome, stored } = await enrich();
    expect(outcome).toMatchObject({ status: "skipped", reason: "suppressed_email" });
    expect(outcome.steps).toContain("icypeas:suppressed_email");
    expect(stored.email).toBeNull();
    expect(check.calls).toEqual([]);
    expect(next.calls).toHaveLength(0);
  });

  it("drops system addresses from finders and replaces one on file", async () => {
    await setup({}, { email: "noreply@brightsmile.test", email_status: "valid" });
    site({ "/": "<html><body>Nothing</body></html>" });
    const noisy = finder("icypeas", { email: "no-reply@brightsmile.test", status: "valid" });
    const good = finder("hunter", { email: "dana@brightsmile.test", status: "valid" });
    ctx.providers.set("email_finder", [noisy.provider, good.provider]);

    const { outcome, stored } = await enrich();
    expect(outcome.steps).toContain("icypeas:role_address");
    expect(outcome).toMatchObject({ status: "found", email: "dana@brightsmile.test" });
    expect(stored.email).toBe("dana@brightsmile.test");
  });

  it("skips verify_only for a system address on file", async () => {
    await setup({}, { email: "postmaster@brightsmile.test", email_status: "unknown" });
    const check = verifier();
    ctx.providers.set("email_verifier", check.provider);
    const { outcome } = await enrich({ mode: "verify_only" });
    expect(outcome).toMatchObject({ status: "skipped", reason: "role_address" });
    expect(check.calls).toEqual([]);
  });
});

describe("runs, budget and the service", () => {
  it("stops spending once the data budget is used up and still reports every person", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    const second = await seedPerson(ctx, {
      company_id: company.id,
      first_name: "Marco",
      last_name: "Pellegrini",
      full_name: "Marco Pellegrini",
      email: null,
    });
    const paid = finder("hunter", { email: "dana@brightsmile.test" });
    ctx.providers.set("email_finder", paid.provider);
    ctx.usage.setOverBudget("data");
    const summary = await runEnrichment(ctx, [person.id, second.id], {
      mode: "find_and_verify",
      operation: "test",
    });
    expect(summary).toMatchObject({
      total: 2,
      skipped: 2,
      budget_exceeded: true,
      skipped_by_reason: { budget_exceeded: 2 },
    });
    expect(paid.calls).toHaveLength(0);
    expect(ctx.emitted("enrichment.completed")).toHaveLength(2);
  });

  it("does not start a paid call that could go past the budget", async () => {
    await setup({ data: { monthly_credit_budget: 2, enrichment: { website_crawler: false } } });
    await ctx.usage.record({
      slot: "email_finder",
      provider: "hunter",
      operation: "earlier",
      credits: 1.5,
    });
    const paid = finder("hunter", { email: "dana@brightsmile.test" });
    ctx.providers.set("email_finder", paid.provider);
    const summary = await runEnrichment(ctx, [person.id], {
      mode: "find_and_verify",
      operation: "test",
    });
    // 0.5 credits left is less than one call: nothing is asked, so the month stays at 1.5 of 2.
    expect(summary).toMatchObject({
      budget_exceeded: true,
      skipped_by_reason: { budget_exceeded: 1 },
    });
    expect(paid.calls).toHaveLength(0);
  });

  it("emits one enrichment.completed per person with the finding provider", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    ctx.providers.set(
      "email_finder",
      finder("hunter", { email: "dana@brightsmile.test", status: "valid" }).provider,
    );
    const summary = await runEnrichment(
      ctx,
      [person.id, person.id, "pe_01k6a3v0q8x3m2n4p5r6s7t8v9"],
      { mode: "find_and_verify", operation: "test" },
    );
    expect(summary).toMatchObject({ total: 1, found: 1, credits_used: 1 });
    expect(ctx.emitted("enrichment.completed").map((e) => e.data)).toEqual([
      {
        person_id: person.id,
        email: "dana@brightsmile.test",
        email_status: "valid",
        provider: "hunter",
        status: "found",
        credits_used: 1,
      },
    ]);
  });

  it("verifyEmailNow stores and returns the status; requestEnrichment enqueues the job", async () => {
    await setup({}, { email: "dana@brightsmile.test", email_status: "unknown" });
    ctx.providers.set("email_verifier", verifier({}, "catch_all").provider);
    expect(await verifyEmailNow(ctx, person.id)).toBe("catch_all");
    await expect(verifyEmailNow(ctx, "pe_01k6a3v0q8x3m2n4p5r6s7t8v9")).rejects.toMatchObject({
      code: "not_found",
    });

    const { jobId } = await requestEnrichment(ctx, {
      personIds: [person.id, person.id],
      mode: "verify_only",
    });
    expect(ctx.enqueued("enrichment.run")[0]).toMatchObject({
      job_id: jobId,
      payload: { person_ids: [person.id], mode: "verify_only" },
    });
  });

  it("the job resumes after the last finished batch on a retry", async () => {
    await setup({ data: { enrichment: { website_crawler: false } } });
    const paid = finder("hunter", { email: "dana@brightsmile.test", status: "valid" });
    ctx.providers.set("email_finder", paid.provider);
    const job = ctx.jobContext({ name: "enrichment.run", attempt: 2 });
    job.jobs.get = async () =>
      ({ progress: { data: { processed: 1, summary: undefined } } }) as never;
    const result = await enrichJob.handler(job, {
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: 0,
    });
    expect(result).toMatchObject({ total: 0 });
    expect(paid.calls).toHaveLength(0);

    const fresh = ctx.jobContext({ name: "enrichment.run" });
    const done = await enrichJob.handler(fresh, {
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: 0,
    });
    expect(done).toMatchObject({ total: 1, found: 1 });
    expect(ctx.recorded.progress.at(-1)).toMatchObject({
      progress: { done: 1, total: 1, stage: "enriching" },
    });
  });
});
