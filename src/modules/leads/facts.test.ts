import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryRows } from "../../db/client.js";
import { lead_facts } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedPerson } from "../../testing/factories.js";
import { deleteFactsForPeople } from "./facts.js";
import {
  deleteFactsForPerson,
  listFacts,
  type RecordFactInput,
  recordFact,
  updateFactStatus,
} from "./service.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DAY = 86_400_000;

async function setup() {
  const ctx = await createTestContext({ db: testDb });
  const company = await seedCompany(ctx);
  const person = await seedPerson(ctx, { company_id: company.id });
  return { ctx, company, person };
}

function fact(over: Partial<RecordFactInput> & Pick<RecordFactInput, "scope">): RecordFactInput {
  return { kind: "fact", text: "Uses HubSpot as their CRM.", source: "manual", ...over };
}

async function row(ctx: TestContext, id: string) {
  const [found] = await ctx.db.select().from(lead_facts).where(eq(lead_facts.id, id));
  if (!found) throw new Error("fact row missing");
  return found;
}

describe("recordFact", () => {
  it("stores a person fact with clean text, its company and author, and emits the event", async () => {
    const { ctx, company, person } = await setup();
    const observedAt = new Date("2026-09-10T08:30:00Z");
    const recorded = await recordFact(ctx, {
      personId: person.id,
      scope: "person",
      kind: "timing",
      text: "  Budget  review\n in   January. ",
      source: "reply",
      sourceRef: "msg_one",
      observedAt,
    });
    expect(recorded).toEqual({ id: expect.stringMatching(/^lf_/), created: true });
    expect(await row(ctx, recorded.id)).toMatchObject({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      company_id: company.id,
      scope: "person",
      kind: "timing",
      text: "Budget review in January.",
      source: "reply",
      source_ref: "msg_one",
      observed_at: observedAt,
      expires_at: null,
      status: "active",
      replaced_by: null,
      created_by: { type: "human", id: "usr_test", name: "Test User", via: "cli" },
    });
    expect(ctx.emitted("lead.fact_recorded")).toEqual([
      {
        id: expect.any(String),
        subject: { type: "person", id: person.id },
        data: {
          fact_id: recorded.id,
          person_id: person.id,
          company_id: company.id,
          kind: "timing",
          source: "reply",
        },
      },
    ]);
  });

  it("cuts text at 280 characters and refuses text with no words", async () => {
    const { ctx, person } = await setup();
    const long = await recordFact(
      ctx,
      fact({ personId: person.id, scope: "person", text: "word ".repeat(80) }),
    );
    const stored = await row(ctx, long.id);
    expect(stored.text.length).toBeLessThanOrEqual(280);
    expect(stored.text).toBe("word ".repeat(56).trim());
    for (const text of ["", "   \n ", "...!?"]) {
      await expect(
        recordFact(ctx, fact({ personId: person.id, scope: "person", text })),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "text" } });
    }
  });

  it("resolves the company of a company fact from the person and keeps who told us", async () => {
    const { ctx, company, person } = await setup();
    const told = await recordFact(
      ctx,
      fact({ personId: person.id, scope: "company", text: "Signed with a competitor." }),
    );
    expect(await row(ctx, told.id)).toMatchObject({
      scope: "company",
      company_id: company.id,
      person_id: person.id,
    });
    expect(ctx.emitted("lead.fact_recorded")[0]?.subject).toEqual({
      type: "company",
      id: company.id,
    });
    const direct = await recordFact(ctx, fact({ companyId: company.id, scope: "company" }));
    expect(await row(ctx, direct.id)).toMatchObject({ company_id: company.id, person_id: null });
  });

  it("explains what is missing or unknown", async () => {
    const { ctx, company } = await setup();
    const loner = await seedPerson(ctx);
    await expect(
      recordFact(ctx, fact({ companyId: company.id, scope: "person" })),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "personId" },
      hint: expect.stringContaining("scope company"),
    });
    await expect(
      recordFact(ctx, fact({ personId: loner.id, scope: "company" })),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "companyId" },
      hint: expect.stringContaining("has no company"),
    });
    await expect(recordFact(ctx, fact({ scope: "company" }))).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "companyId" },
    });
    await expect(
      recordFact(ctx, fact({ personId: "pe_missing", scope: "person" })),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      recordFact(ctx, fact({ companyId: "co_missing", scope: "company" })),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(ctx.emitted("lead.fact_recorded")).toEqual([]);
  });

  it("skips a near-duplicate of an active fact with the same target and kind", async () => {
    const { ctx, company, person } = await setup();
    const colleague = await seedPerson(ctx, { company_id: company.id });
    const first = await recordFact(ctx, fact({ personId: person.id, scope: "person" }));
    expect(
      await recordFact(
        ctx,
        fact({ personId: person.id, scope: "person", text: "  uses hubspot, as their CRM " }),
      ),
    ).toEqual({ id: first.id, created: false });
    // Another kind, another person: new facts.
    expect(
      (await recordFact(ctx, fact({ personId: person.id, scope: "person", kind: "preference" })))
        .created,
    ).toBe(true);
    expect((await recordFact(ctx, fact({ personId: colleague.id, scope: "person" }))).created).toBe(
      true,
    );
    // A company fact told by two people is one fact.
    const holdFact = {
      scope: "company" as const,
      kind: "timing" as const,
      text: "Frozen until March.",
    };
    const told = await recordFact(ctx, fact({ personId: person.id, ...holdFact }));
    expect(await recordFact(ctx, fact({ personId: colleague.id, ...holdFact }))).toEqual({
      id: told.id,
      created: false,
    });
    expect(ctx.emitted("lead.fact_recorded")).toHaveLength(4);

    // Once the old fact is removed, the same text is new again.
    await updateFactStatus(ctx, first.id, "removed");
    expect((await recordFact(ctx, fact({ personId: person.id, scope: "person" }))).created).toBe(
      true,
    );
  });

  it("does not count an expired fact as a duplicate", async () => {
    const { ctx, person } = await setup();
    const input = fact({
      personId: person.id,
      scope: "person",
      kind: "timing",
      text: "Busy with an office move.",
      expiresAt: new Date(ctx.clock.now().getTime() + DAY),
    });
    const first = await recordFact(ctx, input);
    expect((await recordFact(ctx, input)).created).toBe(false);
    ctx.clock.advance(DAY);
    const again = await recordFact(ctx, { ...input, expiresAt: null });
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(first.id);
  });

  it("stores one fact when two callers record the same one at once", async () => {
    const { ctx, person } = await setup();
    const results = await Promise.all([
      recordFact(ctx, fact({ personId: person.id, scope: "person" })),
      recordFact(
        ctx,
        fact({ personId: person.id, scope: "person", text: "Uses HubSpot as their CRM" }),
      ),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]?.id).toBe(results[1]?.id);
  });
});

describe("listFacts", () => {
  it("lists active facts newest observed first and adds company facts on request", async () => {
    const { ctx, company, person } = await setup();
    const at = (day: number) => new Date(Date.UTC(2026, 8, day));
    const add = async (text: string, day: number, over: Partial<RecordFactInput> = {}) =>
      (
        await recordFact(
          ctx,
          fact({ personId: person.id, scope: "person", text, observedAt: at(day), ...over }),
        )
      ).id;
    await add("Old person fact", 1);
    await add("New person fact", 20);
    const removed = await add("Removed person fact", 25);
    await updateFactStatus(ctx, removed, "removed");
    await add("Company fact", 10, { scope: "company" });
    const other = await seedCompany(ctx);
    await recordFact(ctx, fact({ companyId: other.id, scope: "company", text: "Other company" }));

    const texts = async (filter: Parameters<typeof listFacts>[1]) =>
      (await listFacts(ctx, filter)).map((item) => item.text);
    expect(await texts({ personId: person.id })).toEqual(["New person fact", "Old person fact"]);
    expect(await texts({ personId: person.id, includeCompany: true })).toEqual([
      "New person fact",
      "Company fact",
      "Old person fact",
    ]);
    expect(await texts({ companyId: company.id })).toEqual(["Company fact"]);
    expect(await texts({ personId: person.id, statuses: ["removed"] })).toEqual([
      "Removed person fact",
    ]);
    expect(await texts({ personId: person.id, statuses: [] })).toEqual([]);
    expect(await texts({ personId: person.id, limit: 1 })).toEqual(["New person fact"]);
    await expect(listFacts(ctx, {})).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("shows an active fact past its expiry as expired", async () => {
    const { ctx, person } = await setup();
    const { id } = await recordFact(
      ctx,
      fact({
        personId: person.id,
        scope: "person",
        kind: "timing",
        text: "Hiring freeze this month.",
        expiresAt: new Date(ctx.clock.now().getTime() + DAY),
      }),
    );
    expect((await listFacts(ctx, { personId: person.id })).map((item) => item.id)).toEqual([id]);
    ctx.clock.advance(DAY);
    expect(await listFacts(ctx, { personId: person.id })).toEqual([]);
    expect(await listFacts(ctx, { personId: person.id, statuses: ["expired"] })).toMatchObject([
      { id, status: "expired" },
    ]);
  });

  it("returns 50 facts by default and at most 200", async () => {
    const { ctx, person } = await setup();
    const now = ctx.clock.now();
    await ctx.db.insert(lead_facts).values(
      Array.from({ length: 205 }, (_, index) => ({
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        scope: "person" as const,
        kind: "note" as const,
        text: `Note ${index}`,
        source: "manual" as const,
        observed_at: new Date(now.getTime() - index * 60_000),
      })),
    );
    const firstPage = await listFacts(ctx, { personId: person.id });
    expect(firstPage).toHaveLength(50);
    expect(firstPage[0]?.text).toBe("Note 0");
    expect(await listFacts(ctx, { personId: person.id, limit: 500 })).toHaveLength(200);
    expect(await listFacts(ctx, { personId: person.id, limit: 0 })).toHaveLength(1);
  });
});

describe("updateFactStatus", () => {
  it("marks a corrected fact with its replacement and can make it active again", async () => {
    const { ctx, person } = await setup();
    const old = await recordFact(ctx, fact({ personId: person.id, scope: "person" }));
    const fix = await recordFact(
      ctx,
      fact({ personId: person.id, scope: "person", text: "Uses Pipedrive as their CRM." }),
    );
    await updateFactStatus(ctx, old.id, "corrected", { replacedBy: fix.id });
    expect(await row(ctx, old.id)).toMatchObject({ status: "corrected", replaced_by: fix.id });
    expect((await listFacts(ctx, { personId: person.id })).map((item) => item.id)).toEqual([
      fix.id,
    ]);
    await updateFactStatus(ctx, old.id, "active");
    expect(await row(ctx, old.id)).toMatchObject({ status: "active", replaced_by: null });
  });

  it("refuses a fact replacing itself and ids it does not know", async () => {
    const { ctx, person } = await setup();
    const { id } = await recordFact(ctx, fact({ personId: person.id, scope: "person" }));
    await expect(updateFactStatus(ctx, id, "corrected", { replacedBy: id })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      updateFactStatus(ctx, id, "corrected", { replacedBy: "lf_missing" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(updateFactStatus(ctx, "lf_missing", "removed")).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await row(ctx, id)).status).toBe("active");
  });
});

describe("deleteFactsForPerson", () => {
  it("deletes the person's facts and facts from their replies, and unlinks the rest", async () => {
    const { ctx, company, person } = await setup();
    const colleague = await seedPerson(ctx, { company_id: company.id });
    const mine = { personId: person.id };
    await recordFact(ctx, fact({ ...mine, scope: "person" }));
    await recordFact(ctx, fact({ ...mine, scope: "person", kind: "note", text: "Prefers calls." }));
    await recordFact(
      ctx,
      fact({
        ...mine,
        scope: "company",
        text: "Opening a new site.",
        source: "reply",
        sourceRef: "msg_mine",
      }),
    );
    const toldManually = await recordFact(
      ctx,
      fact({ ...mine, scope: "company", kind: "relationship", text: "Works with a partner firm." }),
    );
    const colleagueFact = await recordFact(ctx, fact({ personId: colleague.id, scope: "person" }));
    const colleagueReply = await recordFact(
      ctx,
      fact({
        personId: colleague.id,
        scope: "company",
        kind: "objection",
        text: "Too expensive last year.",
        source: "reply",
        sourceRef: "msg_colleague",
      }),
    );

    expect(
      await deleteFactsForPerson(ctx, person.id, { messageIds: ["msg_mine", "msg_mine"] }),
    ).toBe(3);
    const left = await ctx.db
      .select()
      .from(lead_facts)
      .where(eq(lead_facts.workspace_id, ctx.workspace.id));
    expect(left.map((item) => item.id).sort()).toEqual(
      [toldManually.id, colleagueFact.id, colleagueReply.id].sort(),
    );
    expect(left.find((item) => item.id === toldManually.id)?.person_id).toBeNull();
    expect(await deleteFactsForPerson(ctx, person.id)).toBe(0);
  });
});

describe("deleteFactsForPeople", () => {
  it("erases many people and many replies in batches, and leaves everyone else alone", async () => {
    const { ctx, company, person } = await setup();
    const second = await seedPerson(ctx, { company_id: company.id });
    const other = await seedPerson(ctx, { company_id: company.id });
    const at = ctx.clock.now();
    const base = { workspace_id: ctx.workspace.id, kind: "fact" as const, observed_at: at };
    // More replies than one batch holds, facts taken from each.
    const replyIds = Array.from({ length: 1_203 }, (_, i) => `msg_reply_${i}`);
    await ctx.db.insert(lead_facts).values([
      ...replyIds.map((id) => ({
        ...base,
        company_id: company.id,
        scope: "company" as const,
        text: `Fact from ${id}.`,
        source: "reply" as const,
        source_ref: id,
      })),
      { ...base, person_id: person.id, scope: "person", text: "Prefers calls.", source: "manual" },
      { ...base, person_id: second.id, scope: "person", text: "Prefers email.", source: "manual" },
    ]);
    const told = await recordFact(
      ctx,
      fact({ personId: second.id, scope: "company", text: "Works with a partner firm." }),
    );
    const kept = await recordFact(ctx, fact({ personId: other.id, scope: "person" }));
    const keptReply = await recordFact(
      ctx,
      fact({ companyId: company.id, scope: "company", source: "reply", sourceRef: "msg_other" }),
    );

    expect(
      await deleteFactsForPeople(ctx, [person.id, second.id, person.id], {
        messageIds: replyIds,
      }),
    ).toBe(1_205);
    const left = await ctx.db
      .select()
      .from(lead_facts)
      .where(eq(lead_facts.workspace_id, ctx.workspace.id));
    expect(left.map((item) => item.id).sort()).toEqual([told.id, kept.id, keptReply.id].sort());
    expect(left.find((item) => item.id === told.id)?.person_id).toBeNull();
    expect(left.find((item) => item.id === kept.id)?.person_id).toBe(other.id);
  });

  it("finds facts by their source through an index", async () => {
    const rows = await queryRows<{ indexdef: string }>(
      testDb.db,
      sql`select indexdef from pg_indexes where tablename = 'lead_facts' and indexname = 'lead_facts_workspace_source_idx'`,
    );
    expect(rows[0]?.indexdef).toContain("(workspace_id, source, source_ref)");
  });
});

describe("workspace isolation", () => {
  it("never records on, lists, changes or deletes another workspace's leads", async () => {
    const mine = await setup();
    const theirs = await setup();
    const { id } = await recordFact(
      theirs.ctx,
      fact({ personId: theirs.person.id, scope: "person" }),
    );
    await expect(
      recordFact(mine.ctx, fact({ personId: theirs.person.id, scope: "person" })),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      recordFact(mine.ctx, fact({ companyId: theirs.company.id, scope: "company" })),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await listFacts(mine.ctx, {
        personId: theirs.person.id,
        companyId: theirs.company.id,
        includeCompany: true,
      }),
    ).toEqual([]);
    await expect(updateFactStatus(mine.ctx, id, "removed")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      updateFactStatus(
        mine.ctx,
        (await recordFact(mine.ctx, fact({ personId: mine.person.id, scope: "person" }))).id,
        "corrected",
        {
          replacedBy: id,
        },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await deleteFactsForPerson(mine.ctx, theirs.person.id)).toBe(0);
    expect(await listFacts(theirs.ctx, { personId: theirs.person.id })).toMatchObject([
      { id, status: "active" },
    ]);
  });
});
