/**
 * The lead file operations (notes, facts, corrections, company holds, timeline) and the new
 * fields of get_lead and companies.get.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../../core/operation.js";
import { enrollments, lead_facts, tasks } from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { createTestDb, type TestDb } from "../../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedMessage,
  seedPerson,
} from "../../../testing/factories.js";
import { openProblem } from "../../problems/service.js";
import { holdSuggestionKey } from "../service.js";
import { getCompany } from "./companies.js";
import { addFact, addNote, correctFact, removeFact } from "./facts.js";
import { holdCompanyOp, releaseCompanyOp } from "./holds.js";
import { getLead } from "./people.js";
import { leadTimeline } from "./timeline.js";

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DAY = 86_400_000;
const AGENT = { type: "agent" as const, id: "local-agent", name: "Agent" };

async function setup(timezone = "UTC") {
  const ctx = await createTestContext({ db: testDb, workspace: { timezone } });
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, { company_id: company.id, full_name: "Dana Reyes" });
  return { ctx, company, person };
}

async function factRow(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(lead_facts).where(eq(lead_facts.id, id));
  if (!row) throw new Error("fact missing");
  return row;
}

describe("leads.add_note", () => {
  it("adds a note to a person or a company, once, with the author as source", async () => {
    const { ctx, company, person } = await setup();
    const text = "Met at the regional dental fair; wants a demo for two practices.";
    const first = await call(addNote, ctx, { person_id: person.id, text });
    expect(first).toMatchObject({
      created: true,
      untrusted: true,
      fact: { scope: "person", kind: "note", source: "manual", text, person_id: person.id },
    });
    const again = await call(addNote, ctx, {
      person_id: person.id,
      text: ` ${text.toUpperCase()} `,
    });
    expect(again).toMatchObject({ created: false, fact_id: first.fact_id });

    const byAgent = await call(addNote, ctx.with({ principal: AGENT }), {
      company_id: company.id,
      text: "Front desk moves to the new clinic in November.",
    });
    expect(byAgent.fact).toMatchObject({
      scope: "company",
      source: "agent",
      company_id: company.id,
    });
  });

  it("needs exactly one of person_id and company_id", async () => {
    const { ctx, company, person } = await setup();
    await expect(call(addNote, ctx, { text: "Call back later." })).rejects.toMatchObject({
      code: "validation_failed",
      message: "Say whose file the note belongs to.",
      hint: expect.stringContaining("company_id"),
    });
    await expect(
      call(addNote, ctx, { person_id: person.id, company_id: company.id, text: "Both." }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "Pass person_id or company_id, not both.",
    });
  });
});

describe("leads.add_fact", () => {
  it("stores a timing fact that expires at the end of the given day", async () => {
    const { ctx, person } = await setup();
    const result = await call(addFact, ctx, {
      kind: "timing",
      text: "Budget review for next year happens in November.",
      person_id: person.id,
      expires_on: "2026-11-30",
    });
    expect(result.fact).toMatchObject({
      scope: "person",
      kind: "timing",
      source: "manual",
      expires_at: "2026-11-30T23:59:59.999Z",
    });
    const agentFact = await call(addFact, ctx.with({ principal: AGENT }), {
      kind: "fact",
      text: "Uses HubSpot as their CRM.",
      scope: "company",
      person_id: person.id,
    });
    expect(agentFact.fact).toMatchObject({
      scope: "company",
      source: "agent",
      company_id: person.company_id,
      person_id: person.id,
    });
  });

  it("explains missing targets and bad expiry dates", async () => {
    const { ctx, company, person } = await setup();
    await expect(call(addFact, ctx, { kind: "fact", text: "Uses HubSpot." })).rejects.toMatchObject(
      { code: "validation_failed", hint: expect.stringContaining("person_id") },
    );
    await expect(
      call(addFact, ctx, {
        kind: "fact",
        text: "Uses HubSpot.",
        scope: "person",
        company_id: company.id,
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "A person fact needs person_id.",
    });
    await expect(
      call(addFact, ctx, {
        kind: "timing",
        text: "Budget review in November.",
        person_id: person.id,
        expires_on: "30/11/2026",
      }),
    ).rejects.toMatchObject({ code: "validation_failed", hint: "Use YYYY-MM-DD." });
    await expect(
      call(addFact, ctx, {
        kind: "timing",
        text: "Budget review in November.",
        person_id: person.id,
        expires_on: "2026-09-01",
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("leave expires_on out"),
    });
  });
});

describe("leads.correct_fact and leads.remove_fact", () => {
  it("replaces an active fact and keeps the old one visible as corrected", async () => {
    const { ctx, person } = await setup();
    const original = await call(addFact, ctx, {
      kind: "timing",
      text: "Budget review in November.",
      person_id: person.id,
      expires_on: "2026-12-31",
    });
    const corrected = await call(correctFact, ctx.with({ principal: AGENT }), {
      fact_id: original.fact_id,
      text: "Budget review moved to January.",
    });
    expect(corrected).toMatchObject({
      created: true,
      replaced_fact_id: original.fact_id,
      fact: {
        kind: "timing",
        scope: "person",
        source: "agent",
        status: "active",
        expires_at: "2026-12-31T23:59:59.999Z",
        text: "Budget review moved to January.",
      },
    });
    expect(await factRow(ctx, original.fact_id)).toMatchObject({
      status: "corrected",
      replaced_by: corrected.fact_id,
    });

    await expect(
      call(correctFact, ctx, { fact_id: original.fact_id, text: "Budget review in March." }),
    ).rejects.toMatchObject({
      code: "conflict",
      hint: `It was already corrected: correct fact ${corrected.fact_id} instead.`,
    });
    await expect(
      call(correctFact, ctx, {
        fact_id: corrected.fact_id,
        text: "budget review moved to January",
      }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "text" } });
    await expect(
      call(correctFact, ctx, { fact_id: "lf_01k6a3v0q8x3m2n4p5r6s7t8w9", text: "Anything." }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("removes a fact once and refuses to correct a removed fact", async () => {
    const { ctx, person } = await setup();
    const fact = await call(addFact, ctx, {
      kind: "preference",
      text: "Prefers email over calls.",
      person_id: person.id,
    });
    expect(await call(removeFact, ctx, { fact_id: fact.fact_id })).toEqual({
      fact_id: fact.fact_id,
      status: "removed",
      changed: true,
    });
    expect(await call(removeFact, ctx, { fact_id: fact.fact_id })).toMatchObject({
      changed: false,
    });
    await expect(
      call(correctFact, ctx, { fact_id: fact.fact_id, text: "Prefers calls." }),
    ).rejects.toMatchObject({ code: "conflict", hint: expect.stringContaining("add_fact") });
  });
});

describe("leads.hold_company and leads.release_company", () => {
  async function withEnrollment(timezone?: string) {
    const world = await setup(timezone);
    const { campaign } = await seedCampaign(world.ctx, { status: "active" });
    const enrollment = await seedEnrollment(world.ctx, {
      campaign_id: campaign.id,
      person_id: world.person.id,
      status: "active",
    });
    return { ...world, enrollment };
  }

  it("holds until 00:00 of the date in the workspace timezone with the given reason", async () => {
    const { ctx, company, enrollment } = await withEnrollment("America/Chicago");
    const reasoned = ctx.with({ request: { reason: "Signed with a competitor until March." } });
    const result = await call(holdCompanyOp, reasoned, {
      company_id: company.id,
      until: "2027-03-01",
    });
    expect(result).toMatchObject({
      company_id: company.id,
      changed: true,
      hold: { until: "2027-03-01T06:00:00.000Z", reason: "Signed with a competitor until March." },
      enrollments_paused: 1,
      fact_id: expect.stringMatching(/^lf_/),
    });
    const [row] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, enrollment.id));
    expect(row).toMatchObject({ status: "paused", stop_reason: "company_hold" });

    expect(await call(releaseCompanyOp, ctx, { company_id: company.id })).toEqual({
      company_id: company.id,
      changed: true,
      enrollments_resumed: 1,
    });
    expect(await call(releaseCompanyOp, ctx, { company_id: company.id })).toMatchObject({
      changed: false,
      enrollments_resumed: 0,
    });
  });

  it("takes the reason of an open hold suggestion when none is given", async () => {
    const { ctx, company } = await setup();
    await openProblem(ctx, {
      kind: "company_hold_suggested",
      severity: "normal",
      title: `Hold ${company.name} until 2026-12-01?`,
      reason: "A reply asked us to wait.",
      remedy: `If this is right, run manage_leads action hold_company with company_id ${company.id} and until 2026-12-01.`,
      companyId: company.id,
      data: { until: "2026-12-01", reason: "Merging with another group this autumn" },
      dedupeKey: holdSuggestionKey(company.id),
    });
    const result = await call(holdCompanyOp, ctx, {
      company_id: company.id,
      until: "2026-12-01T09:00:00Z",
    });
    expect(result.hold).toEqual({
      until: "2026-12-01T09:00:00.000Z",
      reason: "Merging with another group this autumn",
    });
  });

  it("explains a missing reason and bad dates", async () => {
    const { ctx, company } = await setup();
    await expect(
      call(holdCompanyOp, ctx, { company_id: company.id, until: "2026-12-01" }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "reason" } });
    const reasoned = ctx.with({ request: { reason: "Asked us to wait." } });
    await expect(
      call(holdCompanyOp, reasoned, { company_id: company.id, until: "next spring" }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("YYYY-MM-DD"),
    });
    await expect(
      call(holdCompanyOp, reasoned, { company_id: company.id, until: "2026-09-01" }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("release_company"),
    });
    await expect(
      call(holdCompanyOp, reasoned, { company_id: company.id, until: "2036-01-01" }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("do_not_contact"),
    });
  });
});

describe("leads.timeline", () => {
  it("needs exactly one of person_id and company_id and a valid cursor", async () => {
    const { ctx, company, person } = await setup();
    await expect(call(leadTimeline, ctx, {})).rejects.toMatchObject({
      code: "validation_failed",
      message: "Say whose history to read.",
    });
    await expect(
      call(leadTimeline, ctx, { person_id: person.id, company_id: company.id }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "Pass person_id or company_id, not both.",
    });
    await expect(
      call(leadTimeline, ctx, { person_id: person.id, cursor: "bm90LWEtY3Vyc29y" }),
    ).rejects.toMatchObject({ code: "validation_failed", message: "Invalid cursor." });
    expect(await call(leadTimeline, ctx, { person_id: person.id })).toEqual({
      items: [],
      next_cursor: null,
      has_more: false,
      untrusted: true,
    });
  });
});

describe("get_lead and companies.get", () => {
  it("get_lead shows active facts, open promises, notes and the latest history", async () => {
    const { ctx, company, person } = await setup();
    await call(addFact, ctx, {
      kind: "fact",
      text: "Uses HubSpot as their CRM.",
      person_id: person.id,
    });
    await call(addFact, ctx, {
      kind: "timing",
      text: "Moving offices in October.",
      scope: "company",
      company_id: company.id,
    });
    const removed = await call(addFact, ctx, {
      kind: "preference",
      text: "Prefers calls.",
      person_id: person.id,
    });
    await call(removeFact, ctx, { fact_id: removed.fact_id });
    await call(addNote, ctx, { person_id: person.id, text: "Met at the dental fair." });
    await ctx.db.insert(tasks).values([
      {
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        type: "promise",
        title: "Send the case study",
        due_at: new Date(ctx.clock.now().getTime() - DAY),
        created_at: new Date(ctx.clock.now().getTime() - 3 * DAY),
      },
      {
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        type: "promise",
        title: "Send pricing",
        status: "done",
        created_at: new Date(ctx.clock.now().getTime() - 3 * DAY),
      },
    ]);
    await seedMessage(ctx, {
      person_id: person.id,
      status: "sent",
      sent_at: new Date(ctx.clock.now().getTime() - 2 * DAY),
      subject: "front desk coverage",
      body_text: "Secret body that must never show in the history.",
    });

    const lead = await call(getLead, ctx, { person_id: person.id });
    expect(lead.facts.map((fact) => fact.text)).toEqual([
      "Moving offices in October.",
      "Uses HubSpot as their CRM.",
    ]);
    expect(lead.lead_notes.map((note) => note.text)).toEqual(["Met at the dental fair."]);
    expect(lead.promises).toEqual([
      expect.objectContaining({ title: "Send the case study", overdue: true }),
    ]);
    expect(lead.timeline[0]).toMatchObject({
      type: "note.added",
      title: "Note: Met at the dental fair.",
    });
    expect(lead.timeline.map((entry) => entry.type)).toContain("message.sent");
    expect(lead.timeline.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(lead.timeline)).not.toContain("Secret body");
    // The relationship view: the overdue promise is the next thing to do.
    expect(lead.relationship).toMatchObject({ person_id: person.id, stuck: false });
    expect(lead.relationship?.next_action).toMatchObject({ kind: "task" });
    expect(lead.notes).not.toContain("relationship unavailable");
    expect(lead.untrusted).toBe(true);
  });

  it("companies.get shows the hold, company facts and what each person is doing", async () => {
    const { ctx, company, person } = await setup();
    const quiet = await seedPerson(ctx, { company_id: company.id, full_name: "Sam Lee" });
    const { campaign } = await seedCampaign(ctx, { status: "active", name: "Dental Q4" });
    await seedEnrollment(ctx, { campaign_id: campaign.id, person_id: person.id, status: "active" });
    await seedMessage(ctx, {
      person_id: person.id,
      direction: "inbound",
      status: "received",
      received_at: new Date(ctx.clock.now().getTime() - DAY),
      classification: { category: "not_now", summary: "Busy until spring." } as never,
    });
    await call(addFact, ctx, {
      kind: "fact",
      text: "Owns four clinics.",
      scope: "company",
      company_id: company.id,
    });
    await call(holdCompanyOp, ctx.with({ request: { reason: "Busy with a merger." } }), {
      company_id: company.id,
      until: new Date(ctx.clock.now().getTime() + 20 * DAY).toISOString(),
    });

    const result = await call(getCompany, ctx, { company_id: company.id });
    expect(result.hold).toMatchObject({ reason: "Busy with a merger." });
    expect(result.facts.map((fact) => fact.text)).toEqual(
      expect.arrayContaining(["Owns four clinics."]),
    );
    const dana = result.people.find((entry) => entry.id === person.id);
    expect(dana?.state).toMatchObject({
      campaign: { name: "Dental Q4", status: "paused" },
      last_reply: { category: "not_now" },
    });
    const sam = result.people.find((entry) => entry.id === quiet.id);
    expect(sam?.state).toEqual({ campaign: null, last_contacted_at: null, last_reply: null });

    const empty = await seedCompany(ctx);
    expect(await call(getCompany, ctx, { company_id: empty.id })).toMatchObject({
      hold: null,
      facts: [],
      lead_notes: [],
      people: [],
    });
  });
});
