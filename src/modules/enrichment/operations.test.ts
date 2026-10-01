import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { companies, people, suppressions } from "../../db/schema/index.js";
import type { EmailVerifierProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { truncateAll } from "../../testing/db.js";
import { seedCompany, seedPerson, seedWorkspace } from "../../testing/factories.js";
import { hashSuppressionValue } from "../leads/suppressions.js";
import { module } from "./index.js";
import { findContactsJob } from "./jobs.js";
import { enrichLeads, findContacts, verifyLeads } from "./operations.js";

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

const validVerifier: EmailVerifierProvider = {
  id: "fakeverify",
  async verify(email) {
    return { email, status: email.startsWith("bad") ? "invalid" : "valid", creditsUsed: 1 };
  },
};

// Websites use the reserved .test TLD: the email extractor drops example.* addresses.
const HOME = `<html><head><title>Zahnarztpraxis Sonnenweg | Startseite</title></head><body>
  <a href="/team">Team</a> <a href="/impressum">Impressum</a>
  <a href="mailto:info@sonnenweg.test">info@sonnenweg.test</a></body></html>`;
const TEAM = `<html><body><main><h2>Dr. Jens Mueller</h2><p>Inhaber und Zahnarzt, j.mueller@sonnenweg.test</p>
  <h2>Petra Klein</h2><p>Praxismanagerin</p></main></body></html>`;
const IMPRINT = `<html><body><main><p>Zahnarztpraxis Sonnenweg</p><p>Sonnenweg 12<br>10115 Berlin</p>
  <p><a href="tel:+49301234567">030 1234567</a></p></main></body></html>`;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx = ctx.with({ workspace: await seedWorkspace(ctx.db, { settings: {} }) });
  for (const list of [ctx.recorded.events, ctx.recorded.jobs, ctx.recorded.brain]) list.length = 0;
  ctx.providers.set("email_finder", null);
  ctx.providers.set("email_verifier", validVerifier);
  ctx.fetch.route("https://sonnenweg.test/", { body: HOME });
  ctx.fetch.route("https://sonnenweg.test/team", { body: TEAM });
  ctx.fetch.route("https://sonnenweg.test/impressum", { body: IMPRINT });
  ctx.fetch.route(/^https:\/\/sonnenweg\.test\/(contact|about)$/, { status: 404, body: "" });
});

describe("module registration", () => {
  it("exposes enrich_leads with an action per operation and registers the jobs", () => {
    const ids = new Set(module.operations?.map((op) => op.id));
    const tool = module.tools?.[0];
    expect(tool?.name).toBe("enrich_leads");
    expect(tool?.toolset).toBe("leads");
    for (const id of Object.values(tool?.actions ?? {})) expect(ids.has(id)).toBe(true);
    expect(module.jobs?.map((job) => job.name)).toEqual([
      "enrichment.run",
      "enrichment.find_contacts",
    ]);
  });
});

describe("enrichment.enrich", () => {
  it("previews counts, finder order and blocked people in a dry run", async () => {
    const company = await seedCompany(ctx, { domain: "sonnenweg.test" });
    const a = await seedPerson(ctx, { company_id: company.id, email: null });
    const b = await seedPerson(ctx, {
      company_id: company.id,
      email: "b@sonnenweg.test",
      email_status: "unknown",
    });
    const c = await seedPerson(ctx, { company_id: company.id, country: "DE", email: null });
    const d = await seedPerson(ctx, {
      company_id: company.id,
      email: "d@sonnenweg.test",
      email_status: "risky",
      email_checked_at: new Date(ctx.clock.now().getTime() - 86_400_000),
    });
    const dry = ctx.with({ request: { dryRun: true } });
    const result = await call(enrichLeads, dry, { person_ids: [a.id, b.id, c.id, d.id] });
    // b (unknown, never checked) may need finding after its check; d was checked yesterday.
    expect(result).toMatchObject({
      dry_run: true,
      preview: {
        people: 4,
        with_email: 2,
        needs_verification: 1,
        needs_finding: 2,
        checked_recently: 1,
        blocked: 1,
        blocked_by_reason: { consent_required: 1 },
        finders: ["website"],
        verifier: "fakeverify",
        pattern_guessing: false,
      },
      estimated_cost: { credits: 3 },
    });
    expect((result as { warnings: string[] }).warnings).toContain(
      "1 person has a risky or unknown address checked in the last 30 days: kept without spending. Pass force true to ask the finders again.",
    );
    const forced = await call(enrichLeads, dry, { person_ids: [d.id], force: true });
    expect(forced).toMatchObject({ preview: { needs_finding: 1, checked_recently: 0 } });
    expect(ctx.recorded.jobs).toHaveLength(0);
  });

  it("counts people the finders found nothing for in the last 30 days apart, like the waterfall", async () => {
    const company = await seedCompany(ctx, { domain: "lindenhof.test" });
    const day = 86_400_000;
    const now = ctx.clock.now().getTime();
    const recent = await seedPerson(ctx, {
      company_id: company.id,
      email: null,
      email_not_found_at: new Date(now - 2 * day),
    });
    const stale = await seedPerson(ctx, {
      company_id: company.id,
      email: null,
      email_not_found_at: new Date(now - 31 * day),
    });
    const invalid = await seedPerson(ctx, {
      company_id: company.id,
      email: "old@lindenhof.test",
      email_status: "invalid",
      email_checked_at: new Date(now - 2 * day),
      email_not_found_at: new Date(now - 2 * day),
    });
    const dry = ctx.with({ request: { dryRun: true } });
    const ids = [recent.id, stale.id, invalid.id];
    const result = await call(enrichLeads, dry, { person_ids: ids });
    expect(result).toMatchObject({
      preview: { needs_finding: 1, not_found_recently: 2, checked_recently: 0 },
    });
    expect((result as { warnings: string[] }).warnings).toContain(
      "2 people had no address found in the last 30 days: skipped without spending. Pass force true to ask the finders again.",
    );
    const forced = await call(enrichLeads, dry, { person_ids: ids, force: true });
    expect(forced).toMatchObject({ preview: { needs_finding: 3, not_found_recently: 0 } });
  });

  it("enqueues the waterfall job for a list and refuses empty selections", async () => {
    const person = await seedPerson(ctx, { email: null });
    const result = await call(enrichLeads, ctx, {
      person_ids: [person.id],
      allow_role_addresses: true,
    });
    expect(result).toMatchObject({ status: "queued", people: 1 });
    expect(ctx.enqueued("enrichment.run")[0]?.payload).toEqual({
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: true,
      force: false,
    });
    await expect(call(enrichLeads, ctx, {})).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      call(enrichLeads, ctx, { filter: { tags: ["nobody-has-this"] } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("enrichment.verify", () => {
  it("verifies stored addresses now and reports unknown ids", async () => {
    const good = await seedPerson(ctx, { email: "dana@sonnenweg.test", email_status: "unknown" });
    const bad = await seedPerson(ctx, { email: "bad@sonnenweg.test", email_status: "unknown" });
    const result = await call(verifyLeads, ctx, {
      person_ids: [good.id, bad.id, "pe_01k6a3v0q8x3m2n4p5r6s7t8v9"],
    });
    expect(result).toMatchObject({
      credits_used: 2,
      items: [
        { person_id: good.id, email_status: "valid", status: "verified" },
        { person_id: bad.id, email_status: "invalid", status: "verified" },
        {
          person_id: "pe_01k6a3v0q8x3m2n4p5r6s7t8v9",
          status: "skipped",
          reason: "person_not_found",
        },
      ],
    });
  });
});

describe("enrichment.find_contacts", () => {
  it("fills company facts from the website and creates the decision makers named there", async () => {
    const company = await seedCompany(ctx, {
      name: "sonnenweg.test",
      domain: "sonnenweg.test",
      website: "https://sonnenweg.test",
      country: "US",
      city: null,
      address: null,
      phone: null,
    });
    ctx.brain.on("enrichment.extract_team", {
      people: [
        { full_name: "Petra Klein", title: "Praxismanagerin", email: null, decision_maker: false },
        {
          full_name: "Dr. Jens Mueller",
          title: "Inhaber und Zahnarzt",
          email: "j.mueller@sonnenweg.test",
          decision_maker: true,
        },
      ],
    });
    const result = await call(findContacts, ctx, { company_ids: [company.id], max_people: 1 });
    expect(result).toMatchObject({
      items: [
        {
          status: "done",
          filled: ["name", "address", "city", "postal_code", "phone"],
          people: [
            {
              full_name: "Dr. Jens Mueller",
              decision_maker: true,
              email: "j.mueller@sonnenweg.test",
              email_source: "https://sonnenweg.test/team",
              email_status: "valid",
              outcome: "created",
            },
          ],
        },
      ],
      credits_used: 1,
    });
    const [stored] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(stored).toMatchObject({
      name: "Zahnarztpraxis Sonnenweg",
      address: "Sonnenweg 12, 10115 Berlin",
      phone: "+49301234567",
    });
    const created = await ctx.db.select().from(people).where(eq(people.company_id, company.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      full_name: "Dr. Jens Mueller",
      tags: ["decision_maker"],
      source: "website",
    });
    // Page text reached the model only inside untrusted blocks.
    expect(ctx.recorded.brain[0]?.user).toContain('<untrusted_content source="website:team">');
  });

  it("never re-creates a person whose published address was erased", async () => {
    const company = await seedCompany(ctx, {
      name: "sonnenweg.test",
      domain: "sonnenweg.test",
      website: "https://sonnenweg.test",
      country: "US",
    });
    await ctx.db.insert(suppressions).values({
      workspace_id: ctx.workspace.id,
      type: "email",
      value: hashSuppressionValue("j.mueller@sonnenweg.test"),
      reason: "gdpr_erasure",
    });
    ctx.brain.on("enrichment.extract_team", {
      people: [
        {
          full_name: "Dr. Jens Mueller",
          title: "Inhaber und Zahnarzt",
          email: "j.mueller@sonnenweg.test",
          decision_maker: true,
        },
        { full_name: "Petra Klein", title: "Praxismanagerin", email: null, decision_maker: false },
      ],
    });
    const result = await call(findContacts, ctx, { company_ids: [company.id], max_people: 3 });
    const item = (
      result as { items: Array<{ people: Array<{ full_name: string }>; notes: string[] }> }
    ).items[0];
    expect(item?.people.map((p) => p.full_name)).toEqual(["Petra Klein"]);
    expect(item?.notes.join(" ")).toContain("suppressed_email");
    const created = await ctx.db.select().from(people).where(eq(people.company_id, company.id));
    expect(created.map((p) => p.full_name)).toEqual(["Petra Klein"]);
    expect(JSON.stringify(created)).not.toContain("mueller");
  });

  it("previews without an AI call or writes in a dry run, and skips blocked companies", async () => {
    const company = await seedCompany(ctx, {
      name: "sonnenweg.test",
      domain: "sonnenweg.test",
      website: "https://sonnenweg.test",
    });
    const dry = ctx.with({ request: { dryRun: true } });
    const result = await call(findContacts, dry, { company_ids: [company.id] });
    expect(result).toMatchObject({
      dry_run: true,
      preview: { items: [{ status: "done", people: [] }] },
    });
    expect(ctx.recorded.brain).toHaveLength(0);
    const [unchanged] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(unchanged?.name).toBe("sonnenweg.test");

    const competitor = await seedCompany(ctx, { status: "competitor" });
    const skipped = await call(findContacts, ctx, { company_ids: [competitor.id] });
    expect(skipped).toMatchObject({ items: [{ status: "skipped", reason: "company_competitor" }] });
    await expect(
      call(findContacts, ctx, { company_ids: ["co_01k6a3v0q8x3m2n4p5r6s7t8w1"] }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("runs more than three companies as a job that can fill details only", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await seedCompany(ctx)).id);
    const result = await call(findContacts, ctx, { company_ids: ids });
    expect(result).toMatchObject({ status: "queued", companies: 4 });

    const company = await seedCompany(ctx, {
      name: "sonnenweg.test",
      domain: "sonnenweg.test",
      website: "https://sonnenweg.test",
    });
    const summary = await findContactsJob.handler(
      ctx.jobContext({ name: "enrichment.find_contacts" }),
      {
        company_ids: [company.id],
        find_people: false,
        create_people: false,
        max_people: 3,
        allow_role_addresses: false,
        list_id: null,
      },
    );
    expect(summary).toMatchObject({
      companies: 1,
      done: 1,
      companies_updated: 1,
      people_created: 0,
    });
    expect(ctx.recorded.brain).toHaveLength(0);
  });
});
