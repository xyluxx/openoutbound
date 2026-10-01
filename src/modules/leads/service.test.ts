import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { list_members, lists, signals, suppressions, workspaces } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { truncateAll } from "../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedPerson,
  seedWorkspace,
} from "../../testing/factories.js";
import {
  addSuppression,
  checkContactable,
  getPersonWithCompany,
  resolvePeople,
  setPersonStatus,
} from "./service.js";
import { hashSuppressionValue, normalizeSuppressionValue } from "./suppressions.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  const workspace = await seedWorkspace(ctx.db, { settings: {} });
  ctx = ctx.with({ workspace });
  ctx.recorded.events.length = 0;
});

async function setSettings(settings: Record<string, unknown>) {
  const { eq } = await import("drizzle-orm");
  const [row] = await ctx.db
    .update(workspaces)
    .set({ settings })
    .where(eq(workspaces.id, ctx.workspace.id))
    .returning();
  if (row) ctx = ctx.with({ workspace: row });
}

describe("checkContactable", () => {
  it("passes a verified person with a company", async () => {
    const company = await seedCompany(ctx);
    const person = await seedPerson(ctx, { company_id: company.id });
    expect(await checkContactable(ctx, { personId: person.id, channel: "email" })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("reports every suppression type with stable codes", async () => {
    const company = await seedCompany(ctx, { domain: "harbor.example.com" });
    const person = await seedPerson(ctx, {
      company_id: company.id,
      email: "dana@harbor.example.com",
      linkedin_url: "https://www.linkedin.com/in/dana-reyes",
    });
    await addSuppression(ctx, {
      type: "email",
      value: "DANA@harbor.example.com",
      reason: "unsubscribed",
      source: "test",
    });
    await addSuppression(ctx, {
      type: "domain",
      value: "https://harbor.example.com",
      reason: "competitor",
      source: "test",
    });
    await addSuppression(ctx, {
      type: "linkedin",
      value: "linkedin.com/in/Dana-Reyes/",
      reason: "manual",
      source: "test",
    });
    await addSuppression(ctx, {
      type: "person",
      value: person.id,
      reason: "manual",
      source: "test",
    });
    await addSuppression(ctx, {
      type: "company",
      value: company.id,
      reason: "customer",
      source: "test",
    });
    const result = await checkContactable(ctx, { personId: person.id, channel: "email" });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "suppressed_email",
        "suppressed_domain",
        "suppressed_linkedin",
        "suppressed_person",
        "suppressed_company",
      ]),
    );
    // Suppressions block every channel.
    const linkedin = await checkContactable(ctx, { personId: person.id, channel: "linkedin" });
    expect(linkedin.reasons).toContain("suppressed_email");
  });

  it("matches hashed (GDPR) suppressions", async () => {
    const person = await seedPerson(ctx, { email: "omar@example.org" });
    await addSuppression(ctx, {
      type: "email",
      value: hashSuppressionValue("omar@example.org"),
      reason: "gdpr_erasure",
      source: "test",
    });
    const result = await checkContactable(ctx, { personId: person.id, channel: "email" });
    expect(result.reasons).toContain("suppressed_email");
  });

  it("checks person and company status", async () => {
    const company = await seedCompany(ctx, { status: "competitor" });
    const person = await seedPerson(ctx, { company_id: company.id, status: "bounced" });
    const email = await checkContactable(ctx, { personId: person.id, channel: "email" });
    expect(email.reasons).toEqual(expect.arrayContaining(["person_bounced", "company_competitor"]));
    const dnc = await seedPerson(ctx, {
      status: "do_not_contact",
      linkedin_url: "https://www.linkedin.com/in/x-1",
    });
    const viaLinkedin = await checkContactable(ctx, { personId: dnc.id, channel: "linkedin" });
    expect(viaLinkedin.reasons).toEqual(["person_do_not_contact"]);
    const bouncedOnLinkedin = await seedPerson(ctx, {
      status: "bounced",
      linkedin_url: "https://www.linkedin.com/in/x-2",
    });
    expect(
      await checkContactable(ctx, { personId: bouncedOnLinkedin.id, channel: "linkedin" }),
    ).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("applies email status against sending settings", async () => {
    const noEmail = await seedPerson(ctx, { email: null });
    expect(
      (await checkContactable(ctx, { personId: noEmail.id, channel: "email" })).reasons,
    ).toEqual(["no_email"]);
    const unknown = await seedPerson(ctx, { email_status: "unknown" });
    expect(
      (await checkContactable(ctx, { personId: unknown.id, channel: "email" })).reasons,
    ).toEqual(["unverified_email"]);
    const catchAll = await seedPerson(ctx, { email_status: "catch_all" });
    expect(
      (await checkContactable(ctx, { personId: catchAll.id, channel: "email" })).reasons,
    ).toEqual(["catch_all_skipped"]);
    const invalidEmail = await seedPerson(ctx, { email_status: "invalid" });
    expect(
      (await checkContactable(ctx, { personId: invalidEmail.id, channel: "email" })).reasons,
    ).toEqual(["invalid_email"]);

    await setSettings({ sending: { require_verified_email: false, catch_all: "allow" } });
    expect((await checkContactable(ctx, { personId: unknown.id, channel: "email" })).ok).toBe(true);
    expect((await checkContactable(ctx, { personId: catchAll.id, channel: "email" })).ok).toBe(
      true,
    );
    expect((await checkContactable(ctx, { personId: invalidEmail.id, channel: "email" })).ok).toBe(
      false,
    );
  });

  it("enforces excluded and consent-required countries", async () => {
    await setSettings({ compliance: { excluded_countries: ["FR"] } });
    const german = await seedPerson(ctx, { country: "DE" });
    expect(
      (await checkContactable(ctx, { personId: german.id, channel: "email" })).reasons,
    ).toEqual(["consent_required"]);
    const consented = await seedPerson(ctx, { country: "AT", custom: { consent: true } });
    expect((await checkContactable(ctx, { personId: consented.id, channel: "email" })).ok).toBe(
      true,
    );
    const germanOnLinkedin = await seedPerson(ctx, {
      country: "DE",
      linkedin_url: "https://www.linkedin.com/in/lukas",
    });
    expect(
      (await checkContactable(ctx, { personId: germanOnLinkedin.id, channel: "linkedin" })).ok,
    ).toBe(true);
    const company = await seedCompany(ctx, { country: "FR" });
    const french = await seedPerson(ctx, { country: null, company_id: company.id });
    expect(
      (await checkContactable(ctx, { personId: french.id, channel: "email" })).reasons,
    ).toEqual(["excluded_country"]);
  });

  it("requires publication evidence in CA and AU unless consent is recorded", async () => {
    const canadian = await seedPerson(ctx, { country: "CA", email_source: "apollo" });
    expect(
      (await checkContactable(ctx, { personId: canadian.id, channel: "email" })).reasons,
    ).toEqual(["publication_evidence_missing"]);
    const published = await seedPerson(ctx, {
      country: "AU",
      email_source: "https://clinic.example.com/contact",
    });
    expect((await checkContactable(ctx, { personId: published.id, channel: "email" })).ok).toBe(
      true,
    );
    const recorded = await seedPerson(ctx, {
      country: "CA",
      custom: { publication_url: "https://clinic.example.com/team" },
    });
    expect((await checkContactable(ctx, { personId: recorded.id, channel: "email" })).ok).toBe(
      true,
    );
    const consented = await seedPerson(ctx, { country: "CA", custom: { consent: true } });
    expect((await checkContactable(ctx, { personId: consented.id, channel: "email" })).ok).toBe(
      true,
    );
    expect(
      (await checkContactable(ctx, { personId: canadian.id, channel: "linkedin" })).reasons,
    ).toEqual(["no_linkedin"]);
  });

  it("treats UK businesses without a corporate legal form as possible sole traders", async () => {
    const soleTrader = await seedCompany(ctx, {
      name: "Smile Studio",
      country: "GB",
      employee_count: 3,
    });
    const person = await seedPerson(ctx, { company_id: soleTrader.id, country: "GB" });
    expect(
      (await checkContactable(ctx, { personId: person.id, channel: "email" })).reasons,
    ).toEqual(["uk_possible_sole_trader"]);
    for (const over of [
      { name: "Smile Studio Ltd.", employee_count: 3 },
      { name: "Smile Studio L.L.P.", employee_count: 3 },
      { name: "Smile Studio", employee_count: 12 },
      { name: "Smile Studio", employee_count: null, employee_range: "11-50" },
      { name: "Smile Studio", employee_count: 2, custom: { legal_form: "Company" } },
    ]) {
      const company = await seedCompany(ctx, { country: "GB", ...over });
      const employee = await seedPerson(ctx, { company_id: company.id, country: "GB" });
      expect((await checkContactable(ctx, { personId: employee.id, channel: "email" })).ok).toBe(
        true,
      );
    }
    await setSettings({ compliance: { uk_sole_trader_check: false } });
    expect((await checkContactable(ctx, { personId: person.id, channel: "email" })).ok).toBe(true);
  });

  it("uses the widened default consent-required countries", async () => {
    for (const country of ["IT", "ES", "NL", "DK", "PL", "BE"]) {
      const person = await seedPerson(ctx, { country });
      expect(
        (await checkContactable(ctx, { personId: person.id, channel: "email" })).reasons,
      ).toEqual(["consent_required"]);
    }
  });

  it("falls back to the email ccTLD when no country is recorded", async () => {
    let n = 0;
    const reasonsOf = async (overrides: Record<string, unknown>) => {
      n += 1;
      // Unique local parts (emails are unique per workspace); the domain is what matters.
      const email = String(overrides.email).replace("@", `${n}@`);
      const person = await seedPerson(ctx, { country: null, ...overrides, email });
      return (await checkContactable(ctx, { personId: person.id, channel: "email" })).reasons;
    };
    expect(await reasonsOf({ email: "dana@praxis-sonnenweg.de" })).toEqual(["consent_required"]);
    expect(await reasonsOf({ email: "lars@tandlaege.dk" })).toEqual(["consent_required"]);
    expect(await reasonsOf({ email: "mia@clinic.com.au", email_source: "apollo" })).toEqual([
      "publication_evidence_missing",
    ]);
    expect(await reasonsOf({ email: "tom@smile.ca", email_source: "hunter" })).toEqual([
      "publication_evidence_missing",
    ]);
    expect(await reasonsOf({ email: "ann@smilestudio.co.uk" })).toEqual([
      "uk_possible_sole_trader",
    ]);
    expect(await reasonsOf({ email: "ann@smile.example.com" })).toEqual([]);
    expect(await reasonsOf({ email: "ann@smile-startup.io" })).toEqual([]);
    // A recorded country always wins over the TLD.
    expect(await reasonsOf({ email: "dana@praxis-sonnenweg.de", country: "US" })).toEqual([]);
    const usCompany = await seedCompany(ctx, { country: "US" });
    expect(
      await reasonsOf({ email: "dana@praxis-sonnenweg.de", company_id: usCompany.id }),
    ).toEqual([]);
    const ukLtd = await seedCompany(ctx, { name: "Smile Studio Ltd", country: null });
    expect(await reasonsOf({ email: "ann@smilestudio.co.uk", company_id: ukLtd.id })).toEqual([]);
    // Exclusions stay on recorded countries only.
    await setSettings({ compliance: { excluded_countries: ["DE"] } });
    expect(await reasonsOf({ email: "dana@praxis-sonnenweg.de" })).toEqual(["consent_required"]);
  });

  it("blocks system role addresses but keeps business inboxes", async () => {
    for (const email of [
      "noreply@clinic.example.com",
      "No_Reply+x@clinic.example.com",
      "postmaster@clinic.example.com",
      "mailer-daemon@clinic.example.com",
      "abuse@clinic.example.com",
    ]) {
      const person = await seedPerson(ctx, { email });
      const result = await checkContactable(ctx, { personId: person.id, channel: "email" });
      expect(result.reasons, email).toEqual(["role_address"]);
    }
    for (const local of ["info", "sales", "contact", "hello", "office"]) {
      const person = await seedPerson(ctx, { email: `${local}@clinic.example.com` });
      const result = await checkContactable(ctx, { personId: person.id, channel: "email" });
      expect(result.ok, local).toBe(true);
    }
    const onLinkedin = await seedPerson(ctx, {
      email: "no-reply@other.example.com",
      linkedin_url: "https://www.linkedin.com/in/dana-rivers-example",
    });
    expect((await checkContactable(ctx, { personId: onLinkedin.id, channel: "linkedin" })).ok).toBe(
      true,
    );
  });

  it("returns person_not_found for unknown and foreign people", async () => {
    const other = await seedWorkspace(ctx.db);
    const foreign = await seedPerson({ db: ctx.db, workspace: other });
    expect(await checkContactable(ctx, { personId: foreign.id, channel: "email" })).toEqual({
      ok: false,
      reasons: ["person_not_found"],
    });
  });
});

describe("addSuppression", () => {
  it("is idempotent and normalizes values", async () => {
    await addSuppression(ctx, {
      type: "email",
      value: " Dana@Example.org ",
      reason: "manual",
      source: "api",
    });
    await addSuppression(ctx, {
      type: "email",
      value: "dana@example.org",
      reason: "unsubscribed",
      source: "api",
    });
    const rows = await ctx.db.select().from(suppressions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: "dana@example.org", reason: "manual" });
  });

  it("rejects invalid values with a validation error", async () => {
    await expect(
      addSuppression(ctx, { type: "email", value: "nope", reason: "manual", source: "api" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(normalizeSuppressionValue("domain", "@Example.org")).toBe("example.org");
    expect(normalizeSuppressionValue("person", "pe_bad")).toBeNull();
  });
});

describe("resolvePeople", () => {
  it("intersects ids, lists and filters and drops foreign ids", async () => {
    const [list] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: "Priority" })
      .returning();
    const a = await seedPerson(ctx, { tags: ["vip"], fit_score: 80 });
    const b = await seedPerson(ctx, { tags: ["vip"], fit_score: 40 });
    const c = await seedPerson(ctx, { tags: [], fit_score: 90 });
    if (!list) throw new Error("no list");
    await ctx.db.insert(list_members).values([
      { list_id: list.id, person_id: a.id },
      { list_id: list.id, person_id: b.id },
    ]);
    const other = await seedWorkspace(ctx.db);
    const foreign = await seedPerson({ db: ctx.db, workspace: other });

    expect(await resolvePeople(ctx, {})).toEqual([]);
    expect(await resolvePeople(ctx, { listId: list.id })).toEqual([a.id, b.id]);
    expect(await resolvePeople(ctx, { listId: list.id, filter: { min_fit_score: 50 } })).toEqual([
      a.id,
    ]);
    expect(await resolvePeople(ctx, { personIds: [c.id, foreign.id] })).toEqual([c.id]);
    expect(await resolvePeople(ctx, { filter: { tags: ["VIP"] } })).toEqual([a.id, b.id]);
    expect(
      await resolvePeople(ctx, { personIds: [a.id, c.id], filter: { tags: ["vip"] } }),
    ).toEqual([a.id]);
  });

  it("expands smart lists, text queries, countries, signals and campaigns", async () => {
    const company = await seedCompany(ctx, { name: "Lumen Home Goods", country: "DE" });
    const inCompany = await seedPerson(ctx, {
      company_id: company.id,
      country: null,
      title: "VP Operations",
    });
    const other = await seedPerson(ctx, { country: "US", title: "Founder" });
    const [smart] = await ctx.db
      .insert(lists)
      .values({
        workspace_id: ctx.workspace.id,
        name: "Germany",
        kind: "smart",
        filter: { countries: ["Germany"] },
      })
      .returning();
    if (!smart) throw new Error("no list");
    expect(await resolvePeople(ctx, { listId: smart.id })).toEqual([inCompany.id]);
    expect(await resolvePeople(ctx, { filter: { query: "lumen operations" } })).toEqual([
      inCompany.id,
    ]);
    expect(await resolvePeople(ctx, { filter: { query: "100%_" } })).toEqual([]);

    await ctx.db.insert(signals).values({
      workspace_id: ctx.workspace.id,
      definition_key: "funding_round",
      company_id: company.id,
      title: "Raised a seed round",
      source: "test",
      dedupe_key: "k1",
    });
    expect(await resolvePeople(ctx, { filter: { signal_keys: ["funding_round"] } })).toEqual([
      inCompany.id,
    ]);

    const { campaign } = await seedCampaign(ctx);
    await seedEnrollment(ctx, { campaign_id: campaign.id, person_id: other.id, status: "active" });
    expect(await resolvePeople(ctx, { filter: { campaign_id: campaign.id } })).toEqual([other.id]);
    expect(await resolvePeople(ctx, { filter: { not_in_active_campaign: true } })).toEqual([
      inCompany.id,
    ]);
  });

  it("fails with not_found for an unknown list", async () => {
    await expect(
      resolvePeople(ctx, { listId: "ls_01k6a3v0q8x3m2n4p5r6s7t8v9" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("records", () => {
  it("loads the person with company and sets status with an event", async () => {
    const company = await seedCompany(ctx);
    const person = await seedPerson(ctx, { company_id: company.id });
    const loaded = await getPersonWithCompany(ctx, person.id);
    expect(loaded.company?.id).toBe(company.id);
    await setPersonStatus(ctx, person.id, "replied");
    await setPersonStatus(ctx, person.id, "replied");
    expect(ctx.emitted("lead.updated")).toHaveLength(1);
    await expect(getPersonWithCompany(ctx, "pe_01k6a3v0q8x3m2n4p5r6s7t8v9")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
