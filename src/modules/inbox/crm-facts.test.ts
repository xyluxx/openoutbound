import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import {
  type Company,
  companies,
  crm_links,
  type Enrollment,
  enrollments,
  lead_facts,
  type Person,
  people,
  suppressions,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCampaign, seedCompany, seedEnrollment, seedPerson } from "../../testing/factories.js";
import { type CrmFactsInput, crmKey, recordCrmFacts, recordCrmFactsOp } from "./crm-facts.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

type CrmSettings = NonNullable<WorkspaceSettingsInput["crm"]>;
const DOMAIN = "harbor-dental.example.com";
const DANA = `dana@${DOMAIN}`;
const MISSING_PERSON = "pe_01k6a3v0q8x3m2n4p5r6s7t8v9";

interface Setup {
  ctx: TestContext;
  company: Company;
  dana: Person;
  omar: Person;
  danaEnrollment: Enrollment;
  omarEnrollment: Enrollment;
}

async function setup(crm: CrmSettings = {}): Promise<Setup> {
  const ctx = await createTestContext({ db: testDb, settings: { crm } });
  const company = await seedCompany(ctx, { name: "Harbor Dental", domain: DOMAIN });
  const dana = await seedPerson(ctx, { company_id: company.id, email: DANA });
  const omar = await seedPerson(ctx, { company_id: company.id, email: `omar@${DOMAIN}` });
  const { campaign } = await seedCampaign(ctx);
  const danaEnrollment = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: dana.id,
  });
  const omarEnrollment = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: omar.id,
  });
  return { ctx, company, dana, omar, danaEnrollment, omarEnrollment };
}

function run(
  ctx: TestContext,
  facts: CrmFactsInput["facts"],
  options: { crm?: string; dryRun?: boolean } = {},
) {
  return recordCrmFacts(
    ctx,
    { crm: options.crm ?? "HubSpot", facts },
    {
      dryRun: options.dryRun ?? false,
    },
  );
}

async function companyRow(t: Setup): Promise<Company> {
  const [row] = await t.ctx.db.select().from(companies).where(eq(companies.id, t.company.id));
  if (!row) throw new Error("missing company");
  return row;
}

async function personRow(ctx: TestContext, id: string): Promise<Person> {
  const [row] = await ctx.db.select().from(people).where(eq(people.id, id));
  if (!row) throw new Error("missing person");
  return row;
}

async function enrollmentState(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, id));
  return { status: row?.status, stop_reason: row?.stop_reason };
}

async function factsOf(ctx: TestContext) {
  const rows = await ctx.db
    .select()
    .from(lead_facts)
    .where(eq(lead_facts.workspace_id, ctx.workspace.id));
  return rows.map((row) => ({
    scope: row.scope,
    text: row.text,
    status: row.status,
    source: row.source,
    source_ref: row.source_ref,
    kind: row.kind,
  }));
}

async function suppressionsOf(ctx: TestContext) {
  const rows = await ctx.db
    .select()
    .from(suppressions)
    .where(eq(suppressions.workspace_id, ctx.workspace.id));
  return rows.map((row) => ({ type: row.type, value: row.value, source: row.source }));
}

describe("crm facts: customer", () => {
  it("marks the company, stops outreach to everyone there, records and links it once", async () => {
    const t = await setup();
    const result = await run(t.ctx, [{ fact: "customer", domain: DOMAIN, external_id: "8462" }]);
    expect(result.crm).toBe("hubspot");
    expect(result.results[0]).toEqual({
      index: 0,
      fact: "customer",
      person_id: null,
      company_id: t.company.id,
      matched_by: "domain",
      unmatched_reason: null,
      effects: [
        "company status customer",
        "stopped 2 enrollments (crm_customer)",
        "fact recorded: Customer in HubSpot",
        "linked company to hubspot 8462",
      ],
      warnings: [],
      changed: true,
      error: null,
    });
    expect(result.summary).toEqual({ facts: 1, changed: 1, unchanged: 0, unmatched: 0, errors: 0 });
    expect(await companyRow(t)).toMatchObject({
      status: "customer",
      crm_updated_at: t.ctx.clock.now(),
    });
    for (const enrollment of [t.danaEnrollment, t.omarEnrollment]) {
      expect(await enrollmentState(t.ctx, enrollment.id)).toEqual({
        status: "stopped",
        stop_reason: "crm_customer",
      });
    }
    expect(await factsOf(t.ctx)).toEqual([
      {
        scope: "company",
        text: "Customer in HubSpot",
        status: "active",
        source: "crm",
        source_ref: "hubspot",
        kind: "relationship",
      },
    ]);
    const links = await t.ctx.db
      .select()
      .from(crm_links)
      .where(eq(crm_links.workspace_id, t.ctx.workspace.id));
    expect(links).toEqual([
      expect.objectContaining({
        provider: "hubspot",
        entity_type: "company",
        entity_id: t.company.id,
        external_id: "8462",
      }),
    ]);
    expect(t.ctx.emitted("crm.fact_recorded")).toEqual([
      {
        id: expect.any(String),
        subject: { type: "company", id: t.company.id },
        data: { fact: "customer", person_id: null, company_id: t.company.id, crm: "hubspot" },
      },
    ]);

    // The same fact again changes nothing and fires nothing, but the CRM did report.
    t.ctx.clock.advanceBy({ hours: 1 });
    const again = await run(t.ctx, [{ fact: "customer", domain: DOMAIN, external_id: "8462" }]);
    expect(again.results[0]).toMatchObject({ changed: false, effects: [] });
    expect(again.summary).toMatchObject({ changed: 0, unchanged: 1 });
    expect(t.ctx.emitted("crm.fact_recorded")).toHaveLength(1);
    expect((await companyRow(t)).crm_updated_at).toEqual(t.ctx.clock.now());
  });

  it("not_customer lifts it again and replaces the earlier fact", async () => {
    const t = await setup();
    await run(t.ctx, [{ fact: "customer", domain: DOMAIN }]);
    const result = await run(t.ctx, [{ fact: "not_customer", domain: DOMAIN }]);
    expect(result.results[0]).toMatchObject({
      matched_by: "domain",
      company_id: t.company.id,
      effects: ["company status active (was customer)", "fact recorded: Not a customer in HubSpot"],
    });
    expect((await companyRow(t)).status).toBe("active");
    expect(await factsOf(t.ctx)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Customer in HubSpot", status: "corrected" }),
        expect.objectContaining({ text: "Not a customer in HubSpot", status: "active" }),
      ]),
    );
  });

  it("never overrides a stronger status, and marks a person without a company", async () => {
    const t = await setup();
    await t.ctx.db
      .update(companies)
      .set({ status: "do_not_contact" })
      .where(eq(companies.id, t.company.id));
    const blocked = await run(t.ctx, [{ fact: "customer", domain: DOMAIN }]);
    expect(blocked.results[0]?.warnings).toEqual(["The company status stays do_not_contact."]);
    expect((await companyRow(t)).status).toBe("do_not_contact");

    const solo = await seedPerson(t.ctx, { email: "solo@example.org" });
    const unsubscribed = await seedPerson(t.ctx, { status: "unsubscribed" });
    const result = await run(t.ctx, [
      { fact: "customer", person_id: solo.id },
      { fact: "customer", person_id: unsubscribed.id },
    ]);
    expect(result.results[0]).toMatchObject({
      matched_by: "person_id",
      company_id: null,
      effects: ["person status customer", "fact recorded: Customer in HubSpot"],
    });
    expect((await personRow(t.ctx, solo.id)).status).toBe("customer");
    expect(result.results[1]?.warnings).toEqual(["The person status stays unsubscribed."]);
    expect((await personRow(t.ctx, unsubscribed.id)).status).toBe("unsubscribed");
    const personFacts = (await factsOf(t.ctx)).filter((fact) => fact.scope === "person");
    expect(personFacts).toHaveLength(2);
  });
});

describe("crm facts: deals and owners", () => {
  it("open_deal flags the person's company and stops outreach there; no_open_deal clears it", async () => {
    const t = await setup();
    const open = await run(t.ctx, [{ fact: "open_deal", email: DANA, owner: "Sam Park" }], {
      crm: "pipedrive",
    });
    expect(open.results[0]).toMatchObject({
      company_id: t.company.id,
      effects: [
        "open deal set",
        "stopped 2 enrollments (crm_open_deal)",
        "fact recorded: Open deal in Pipedrive, owned by Sam Park",
      ],
    });
    expect((await companyRow(t)).crm_open_deal).toBe(true);
    expect(await enrollmentState(t.ctx, t.omarEnrollment.id)).toEqual({
      status: "stopped",
      stop_reason: "crm_open_deal",
    });

    const cleared = await run(t.ctx, [{ fact: "no_open_deal", domain: DOMAIN }], {
      crm: "pipedrive",
    });
    expect(cleared.results[0]?.effects).toEqual([
      "open deal cleared",
      "fact recorded: No open deal in Pipedrive",
    ]);
    expect((await companyRow(t)).crm_open_deal).toBe(false);
    const lost = await run(
      t.ctx,
      [{ fact: "closed_lost", domain: DOMAIN, note: "Went with a competitor" }],
      {
        crm: "pipedrive",
      },
    );
    expect(lost.results[0]?.effects).toEqual([
      "fact recorded: Deal closed lost in Pipedrive. Went with a competitor",
    ]);
    // One lost deal is its own fact; it does not retire what the account's deals look like.
    const active = (await factsOf(t.ctx)).filter((fact) => fact.status === "active");
    expect(active.map((fact) => fact.text).sort()).toEqual([
      "Deal closed lost in Pipedrive. Went with a competitor",
      "No open deal in Pipedrive",
    ]);
  });

  it("never lifts a block on the whole account from a fact about one contact or one deal", async () => {
    const t = await setup();
    await run(t.ctx, [
      { fact: "customer", domain: DOMAIN },
      { fact: "open_deal", domain: DOMAIN },
    ]);

    // One contact is not a customer: the account stays one.
    const contact = await run(t.ctx, [{ fact: "not_customer", email: DANA }]);
    expect(contact.results[0]).toMatchObject({ person_id: t.dana.id, company_id: t.company.id });
    expect(contact.results[0]?.effects).not.toContain("company status active (was customer)");
    expect(contact.results[0]?.warnings).toEqual([
      "The company's customer status stays: a fact about one contact or one deal never lifts a block on the whole account. Send not_customer with the company's domain or company_id when it applies to the account.",
    ]);
    expect((await companyRow(t)).status).toBe("customer");

    // One deal lost, or no open deal said about one contact: the open deal flag stays.
    const lost = await run(t.ctx, [{ fact: "closed_lost", domain: DOMAIN }]);
    expect(lost.results[0]?.effects).not.toContain("open deal cleared");
    expect(lost.results[0]?.warnings[0]).toContain("The company's open deal flag stays");
    const viaContact = await run(t.ctx, [{ fact: "no_open_deal", email: DANA }]);
    expect(viaContact.results[0]?.effects).not.toContain("open deal cleared");
    expect(viaContact.results[0]?.warnings[0]).toContain("Send no_open_deal with the company's");
    expect((await companyRow(t)).crm_open_deal).toBe(true);

    // Named by company_id, it lifts.
    const named = await run(t.ctx, [
      { fact: "no_open_deal", company_id: t.company.id },
      { fact: "not_customer", company_id: t.company.id },
    ]);
    expect(named.results.map((row) => row.effects[0])).toEqual([
      "open deal cleared",
      "company status active (was customer)",
    ]);
    expect(await companyRow(t)).toMatchObject({ status: "active", crm_open_deal: false });

    // A person with no company is their own account: their status still lifts.
    const solo = await seedPerson(t.ctx, { email: "solo@example.org", status: "customer" });
    const own = await run(t.ctx, [{ fact: "not_customer", email: "solo@example.org" }]);
    expect(own.results[0]?.effects[0]).toBe("person status active (was customer)");
    expect((await personRow(t.ctx, solo.id)).status).toBe("active");
  });

  it("open_deal keeps outreach going with allow_outreach_with_open_deal, and warns without a company", async () => {
    const t = await setup({ allow_outreach_with_open_deal: true });
    const result = await run(t.ctx, [{ fact: "open_deal", domain: DOMAIN }]);
    expect(result.results[0]?.effects).toEqual([
      "open deal set",
      "fact recorded: Open deal in HubSpot",
    ]);
    expect(await enrollmentState(t.ctx, t.danaEnrollment.id)).toMatchObject({ status: "active" });

    const strict = await setup();
    const solo = await seedPerson(strict.ctx, { email: "solo@example.org" });
    const { campaign } = await seedCampaign(strict.ctx);
    const enrollment = await seedEnrollment(strict.ctx, {
      campaign_id: campaign.id,
      person_id: solo.id,
    });
    const alone = await run(strict.ctx, [{ fact: "open_deal", email: "solo@example.org" }]);
    expect(alone.results[0]?.warnings[0]).toContain("The person has no company");
    expect(alone.results[0]?.effects).toContain("stopped 1 enrollment (crm_open_deal)");
    expect(await enrollmentState(strict.ctx, enrollment.id)).toEqual({
      status: "stopped",
      stop_reason: "crm_open_deal",
    });
  });

  it("owned_by stores the owner and stops outreach only with skip_owned_accounts", async () => {
    const t = await setup();
    const owned = await run(t.ctx, [{ fact: "owned_by", domain: DOMAIN, owner: "Sam Park" }]);
    expect(owned.results[0]?.effects).toEqual([
      "owner set to Sam Park",
      "fact recorded: Account owned by Sam Park in HubSpot",
    ]);
    expect((await companyRow(t)).crm_owner).toBe("Sam Park");
    expect(await enrollmentState(t.ctx, t.danaEnrollment.id)).toMatchObject({ status: "active" });

    const cleared = await run(t.ctx, [{ fact: "owned_by", domain: DOMAIN, owner: null }]);
    expect(cleared.results[0]?.effects).toEqual([
      "owner cleared",
      "fact recorded: No account owner in HubSpot",
    ]);
    expect((await companyRow(t)).crm_owner).toBeNull();

    const skip = await setup({ skip_owned_accounts: true });
    const stopped = await run(skip.ctx, [{ fact: "owned_by", domain: DOMAIN, owner: "Sam Park" }]);
    expect(stopped.results[0]?.effects).toContain("stopped 2 enrollments (crm_owned)");
  });
});

describe("crm facts: do_not_contact", () => {
  it("suppresses the person, and only their enrollments stop", async () => {
    const t = await setup();
    const result = await run(t.ctx, [{ fact: "do_not_contact", email: DANA, external_id: "301" }]);
    expect(result.results[0]).toMatchObject({
      person_id: t.dana.id,
      company_id: t.company.id,
      effects: [
        "person status do_not_contact",
        "email suppressed",
        "stopped 1 enrollment (crm_do_not_contact)",
        "fact recorded: Do not contact, according to HubSpot",
        "linked person to hubspot 301",
      ],
    });
    expect((await personRow(t.ctx, t.dana.id)).status).toBe("do_not_contact");
    expect(await suppressionsOf(t.ctx)).toEqual([{ type: "email", value: DANA, source: "crm" }]);
    expect(await enrollmentState(t.ctx, t.omarEnrollment.id)).toMatchObject({ status: "active" });
    expect((await factsOf(t.ctx))[0]).toMatchObject({ scope: "person" });
    expect(t.ctx.emitted("crm.fact_recorded")[0]?.data).toEqual({
      fact: "do_not_contact",
      person_id: t.dana.id,
      company_id: t.company.id,
      crm: "hubspot",
    });
  });

  it("suppresses a whole company by domain", async () => {
    const t = await setup();
    const result = await run(t.ctx, [{ fact: "do_not_contact", domain: DOMAIN }]);
    expect(result.results[0]?.effects).toEqual([
      "company status do_not_contact",
      "company suppressed",
      "stopped 2 enrollments (crm_do_not_contact)",
      "fact recorded: Do not contact, according to HubSpot",
    ]);
    expect(await suppressionsOf(t.ctx)).toEqual([
      { type: "company", value: t.company.id, source: "crm" },
    ]);
  });

  it("never suppresses a free-mail domain: an email is suppressed, a bare domain refused", async () => {
    const t = await setup();
    const result = await run(t.ctx, [
      { fact: "do_not_contact", domain: "gmail.com" },
      { fact: "do_not_contact", domain: "gmail.com", email: "dana.reyes.home@gmail.com" },
    ]);
    expect(result.results[0]).toMatchObject({
      changed: false,
      error:
        "gmail.com is a free email provider, not a company: blocking it would block everyone who uses it. Send the person's email (or person_id) instead.",
    });
    expect(result.results[1]).toMatchObject({ effects: ["email suppressed"], error: null });
    expect(await suppressionsOf(t.ctx)).toEqual([
      { type: "email", value: "dana.reyes.home@gmail.com", source: "crm" },
    ]);
    expect(result.summary).toMatchObject({ errors: 1, changed: 1 });
  });

  it("suppresses an address or a domain the engine has never seen", async () => {
    const t = await setup();
    const result = await run(t.ctx, [
      { fact: "do_not_contact", email: "Someone@Unknown.example.org" },
      { fact: "do_not_contact", domain: "https://www.elsewhere.example.org/about" },
    ]);
    expect(result.results[0]).toMatchObject({
      person_id: null,
      company_id: null,
      effects: ["email suppressed"],
      unmatched_reason: "No lead matches, but the address is suppressed so it is never contacted.",
    });
    expect(result.results[1]?.effects).toEqual(["domain suppressed"]);
    expect(await suppressionsOf(t.ctx)).toEqual(
      expect.arrayContaining([
        { type: "email", value: "someone@unknown.example.org", source: "crm" },
        { type: "domain", value: "elsewhere.example.org", source: "crm" },
      ]),
    );
    expect(t.ctx.emitted("crm.fact_recorded")).toHaveLength(2);
    expect(result.summary).toMatchObject({ changed: 2, unmatched: 2 });
  });
});

describe("crm facts: matching and errors", () => {
  it("finds the account from a work address it does not know, but never from free mail", async () => {
    const t = await setup();
    const result = await run(t.ctx, [
      { fact: "customer", email: `new.buyer@${DOMAIN}`, external_id: "c-77" },
      { fact: "customer", email: "someone@gmail.com" },
    ]);
    expect(result.results[0]).toMatchObject({
      person_id: null,
      company_id: t.company.id,
      matched_by: "email_domain",
      warnings: ["external_id was not linked: no person matches the email."],
    });
    expect(result.results[1]).toMatchObject({
      person_id: null,
      company_id: null,
      changed: false,
      unmatched_reason: "No person or company in this workspace matches.",
    });
    expect(result.summary).toMatchObject({ changed: 1, unmatched: 1 });
    expect(t.ctx.emitted("crm.fact_recorded")).toHaveLength(1);
  });

  it("reports a bad fact in its own result and applies the others", async () => {
    const t = await setup();
    const result = await run(t.ctx, [
      { fact: "customer" },
      { fact: "customer", person_id: MISSING_PERSON },
      { fact: "customer", email: "not-an-email" },
      { fact: "customer", domain: DOMAIN },
    ]);
    expect(result.results.map((row) => row.error)).toEqual([
      "Say who the fact is about: give email, domain, person_id or company_id.",
      `Person ${MISSING_PERSON} not found.`,
      '"not-an-email" is not a valid email address.',
      null,
    ]);
    expect(result.summary).toEqual({ facts: 4, changed: 1, unchanged: 0, unmatched: 0, errors: 3 });
  });

  it("names CRMs by a short key", () => {
    expect(crmKey("HubSpot")).toBe("hubspot");
    expect(crmKey(" Zoho CRM ")).toBe("zoho_crm");
    expect(() => crmKey("!!!")).toThrow(expect.objectContaining({ code: "validation_failed" }));
  });
});

describe("crm facts: dry run", () => {
  it("changes nothing and says what would happen", async () => {
    const t = await setup();
    const facts: CrmFactsInput["facts"] = [
      { fact: "customer", domain: DOMAIN, external_id: "8462" },
      { fact: "do_not_contact", email: "nobody@unknown.example.org" },
      { fact: "customer", person_id: MISSING_PERSON },
    ];
    const preview = await recordCrmFactsOp.handler(t.ctx.with({ request: { dryRun: true } }), {
      crm: "hubspot",
      facts,
    });
    expect(preview).toMatchObject({
      dry_run: true,
      warnings: [`Fact 2: Person ${MISSING_PERSON} not found.`],
      preview: {
        results: [
          {
            effects: [
              "company status customer",
              "would stop 2 enrollments (crm_customer)",
              "would record fact: Customer in HubSpot",
              "would link company to hubspot 8462",
            ],
          },
          { effects: ["email suppressed"] },
          { error: `Person ${MISSING_PERSON} not found.` },
        ],
      },
    });
    expect((await companyRow(t)).status).toBe("active");
    expect((await companyRow(t)).crm_updated_at).toBeNull();
    expect(await enrollmentState(t.ctx, t.danaEnrollment.id)).toMatchObject({ status: "active" });
    expect(await factsOf(t.ctx)).toEqual([]);
    expect(await suppressionsOf(t.ctx)).toEqual([]);
    const links = await t.ctx.db
      .select()
      .from(crm_links)
      .where(and(eq(crm_links.workspace_id, t.ctx.workspace.id)));
    expect(links).toEqual([]);
    expect(t.ctx.recorded.events).toEqual([]);

    const real = await recordCrmFactsOp.handler(t.ctx, { crm: "hubspot", facts });
    expect(real).toMatchObject({ crm: "hubspot", summary: { changed: 2, errors: 1 } });
  });
});
