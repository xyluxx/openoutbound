/**
 * Campaign, enrollment, lifecycle, message, preview and teach operations through the real
 * executor (input and output schemas, scopes, dry runs). Modules that are not merged yet
 * (leads, email, linkedin, signals) are mocked.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvals,
  campaign_steps,
  campaigns,
  change_log,
  enrollments,
  icps,
  messages,
  type Person,
  templates,
} from "../../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../../testing/engine.js";
import {
  type SeedTarget,
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedMailbox,
  seedMessage,
  seedPerson,
} from "../../../testing/factories.js";
import { createFakeBrain } from "../../../testing/fake-brain.js";
import { checkContactable, resolvePeople } from "../../leads/service.js";
import { getActiveSignals } from "../../signals/service.js";

vi.mock("../../leads/service.js", async (importOriginal) => {
  const { loadPerson } = await import("../people.js");
  return {
    ...(await importOriginal<object>()),
    checkContactable: vi.fn(),
    resolvePeople: vi.fn(),
    getPersonWithCompany: vi.fn(loadPerson),
  };
});
vi.mock("../../signals/service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveSignals: vi.fn(),
  markSignalsUsed: vi.fn(),
}));

const DRAFT =
  "Hi Dana, I saw that Harbor opened a second clinic in Round Rock this month. New locations usually mean the front desk juggles twice the calls while the team settles in. We answer overflow calls for dental groups so patients never hit voicemail during lunch. Would that be useful while Round Rock ramps up?";

const brain = createFakeBrain({
  handlers: {
    "campaign.email.write": {
      subject: "round rock front desk",
      body: DRAFT,
      angle: "Coverage while the new clinic ramps up",
      signals_used: [],
      facts_used: [],
    },
    "campaign.email.check": { verdict: "pass", confidence: 0.9, issues: [] },
    "campaign.teach": {
      rules: ["Never mention funding rounds.", "Keep subjects under four words."],
    },
  },
});

let engine: TestEngine;
beforeAll(async () => {
  engine = await createTestEngine({ brain });
});
afterAll(async () => {
  await engine.close();
});
beforeEach(() => {
  vi.mocked(checkContactable).mockResolvedValue({ ok: true, reasons: [] });
  vi.mocked(resolvePeople).mockResolvedValue([]);
  vi.mocked(getActiveSignals).mockResolvedValue([]);
});

interface Space {
  slug: string;
  id: string;
  target: SeedTarget;
  mailboxId: string;
  call<T = Record<string, unknown>>(op: string, input: unknown): Promise<T>;
}

let counter = 0;
async function space(settings: Record<string, unknown> = {}): Promise<Space> {
  counter += 1;
  const workspace = (await engine.call("workspaces.create", {
    name: `Ops Workspace ${counter}`,
    settings: {
      company: { name: "Brightline Answering", postal_address: "1 Example Way, Austin, TX" },
      ...settings,
    },
  })) as { id: string; slug: string };
  const target = { db: engine.db, workspace: { id: workspace.id } };
  const mailbox = await seedMailbox(target);
  return {
    slug: workspace.slug,
    id: workspace.id,
    target,
    mailboxId: mailbox.id,
    call: async <T>(op: string, input: unknown) =>
      (await engine.call(op, input, { workspace: workspace.slug })) as T,
  };
}

async function dana(s: Space): Promise<Person> {
  const company = await seedCompany(s.target, { name: "Harbor Dental" });
  return seedPerson(s.target, {
    first_name: "Dana",
    last_name: "Reyes",
    full_name: "Dana Reyes",
    company_id: company.id,
    fit_score: 80,
  });
}

interface Detail {
  id: string;
  status: string;
  review_level: string;
  template_key: string | null;
  icp_id: string | null;
  settings: Record<string, unknown>;
  steps: Array<{ id: string; position: number; type: string; config: Record<string, unknown> }>;
  enrollment_counts: Record<string, number>;
}

describe("campaigns.create / update / duplicate / delete", () => {
  it("creates a draft from a built-in template with the workspace review default", async () => {
    const s = await space({ approvals: { default_review_level: "every" } });
    const [icp] = await engine.db
      .insert(icps)
      .values({ workspace_id: s.id, name: "Dental groups" })
      .returning();
    const created = await s.call<Detail>("campaigns.create", {
      name: "Dental groups, Q4",
      template: "signal_based_email_4",
      icp_id: icp?.id,
      settings: { senders: { mailbox_ids: [s.mailboxId] }, daily_new_leads: 15 },
    });
    expect(created).toMatchObject({
      status: "draft",
      review_level: "every",
      template_key: "signal_based_email_4",
      icp_id: icp?.id,
    });
    expect(created.steps.map((step) => [step.type, step.config.mode])).toEqual([
      ["email", "new_thread"],
      ["email", "reply"],
      ["email", "reply"],
      ["email", "new_thread"],
    ]);
    expect(created.settings).toMatchObject({
      daily_new_leads: 15,
      senders: { mailbox_ids: [s.mailboxId] },
      schedule: { start_hour: 8, timezone_mode: "lead" },
    });
  });

  it("rejects invalid steps, unknown senders and empty campaigns with field paths", async () => {
    const s = await space();
    await expect(
      s.call("campaigns.create", {
        name: "Broken",
        steps: [
          { type: "email", config: { style: "exact" } },
          { type: "condition", config: { if: "has_email", then_step: 0 } },
        ],
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("steps.0.config.body"),
    });
    await expect(
      s.call("campaigns.create", {
        name: "Unknown sender",
        steps: [{ type: "email" }],
        settings: { senders: { mailbox_ids: ["mbx_01k6a3v0q8x3m2n4p5r6s7t8v9"] } },
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("mailbox"),
    });
    await expect(s.call("campaigns.create", { name: "Empty" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("deep-merges settings and keeps enrollments on their step when steps change", async () => {
    const s = await space();
    const created = await s.call<Detail>("campaigns.create", {
      name: "Live edits",
      steps: [
        { type: "email" },
        { type: "task", config: { title: "Call" } },
        { type: "task", config: { title: "Write a card" } },
      ],
      settings: { senders: { mailbox_ids: [s.mailboxId] }, daily_new_leads: 30 },
    });
    await engine.db.update(campaigns).set({ status: "active" }).where(eq(campaigns.id, created.id));
    const [a, b, c] = created.steps;
    const onB = await seedEnrollment(s.target, {
      campaign_id: created.id,
      person_id: (await seedPerson(s.target)).id,
      current_step: 1,
    });
    const onC = await seedEnrollment(s.target, {
      campaign_id: created.id,
      person_id: (await seedPerson(s.target)).id,
      current_step: 2,
    });

    const updated = await s.call<Detail>("campaigns.update", {
      campaign_id: created.id,
      settings: { review_level: "every", writing: { instructions: "Be brief." } },
      steps: [
        { type: "wait", delay_days: 1 },
        { id: a?.id, type: "email" },
        { id: c?.id, type: "task", config: { title: "Write a card" } },
      ],
    });
    expect(updated.settings).toMatchObject({
      review_level: "every",
      daily_new_leads: 30,
      writing: { instructions: "Be brief." },
      senders: { mailbox_ids: [s.mailboxId] },
    });
    expect(updated.steps.map((step) => step.id)).toEqual([expect.any(String), a?.id, c?.id]);
    expect(updated.steps.some((step) => step.id === b?.id)).toBe(false);
    const position = async (id: string) =>
      (await engine.db.select().from(enrollments).where(eq(enrollments.id, id)))[0]?.current_step;
    expect(await position(onC.id)).toBe(2);
    expect(await position(onB.id)).toBe(2);
  });

  it("refuses to edit archived campaigns and duplicates them instead", async () => {
    const s = await space();
    const { campaign } = await seedCampaign(s.target, {
      status: "archived",
      steps: [{ type: "email" }, { type: "wait", delay_days: 2 }],
    });
    await expect(
      s.call("campaigns.update", { campaign_id: campaign.id, name: "New name" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const copy = await s.call<Detail & { name: string }>("campaigns.duplicate", {
      campaign_id: campaign.id,
    });
    expect(copy).toMatchObject({ status: "draft", name: `Copy of ${campaign.name}` });
    expect(copy.steps.map((step) => step.type)).toEqual(["email", "wait"]);
  });

  it("deletes drafts and archives campaigns with history", async () => {
    const s = await space();
    const { campaign: draft } = await seedCampaign(s.target);
    expect(await s.call("campaigns.delete", { campaign_id: draft.id })).toMatchObject({
      result: "deleted",
    });
    expect(await engine.db.select().from(campaigns).where(eq(campaigns.id, draft.id))).toEqual([]);

    const { campaign: live } = await seedCampaign(s.target, { status: "active" });
    const person = await seedPerson(s.target);
    const running = await seedEnrollment(s.target, { campaign_id: live.id, person_id: person.id });
    await seedMessage(s.target, { campaign_id: live.id, person_id: person.id, status: "sent" });
    expect(await s.call("campaigns.delete", { campaign_id: live.id })).toMatchObject({
      result: "archived",
      stopped_enrollments: 1,
    });
    const [row] = await engine.db.select().from(enrollments).where(eq(enrollments.id, running.id));
    expect(row).toMatchObject({ status: "stopped", stop_reason: "campaign_archived" });
  });
});

describe("templates", () => {
  it("lists built-ins and saved templates and creates campaigns from saved ones", async () => {
    const s = await space();
    const listed = await s.call<{ items: Array<{ key: string; source: string }> }>(
      "campaigns.templates",
      {},
    );
    expect(listed.items.map((item) => item.key)).toEqual([
      "signal_based_email_4",
      "email_linkedin_6",
      "local_business_3",
      "event_follow_up",
      "re_engage_lost",
    ]);

    const source = await s.call<Detail>("campaigns.create", {
      name: "Clinics",
      template: "local_business_3",
      settings: { senders: { mailbox_ids: [s.mailboxId] }, writing: { rules: ["No jargon."] } },
    });
    const saved = await s.call<{ template_id: string; step_count: number }>(
      "campaigns.save_as_template",
      { campaign_id: source.id, name: "Clinic owners, 3 touches" },
    );
    expect(saved.step_count).toBe(3);
    const [row] = await engine.db
      .select()
      .from(templates)
      .where(eq(templates.id, saved.template_id));
    expect(JSON.stringify(row?.content)).not.toContain(s.mailboxId);

    const detailed = (await engine.call(
      "campaigns.templates",
      { response_format: "detailed" },
      { workspace: s.slug },
    )) as { items: Array<{ key: string; source: string; steps: Array<{ config?: unknown }> }> };
    const mine = detailed.items.find((item) => item.key === saved.template_id);
    expect(mine).toMatchObject({ source: "saved" });
    expect(mine?.steps[0]?.config).toMatchObject({ mode: "new_thread", style: "free" });

    const fromSaved = await s.call<Detail>("campaigns.create", {
      name: "Clinics, round 2",
      template: saved.template_id,
    });
    expect(fromSaved.steps).toHaveLength(3);
    expect(fromSaved.settings).toMatchObject({
      writing: { rules: ["No jargon."] },
      senders: { mailbox_ids: [] },
    });
  });
});

describe("enroll and unenroll", () => {
  it("enrolls a list through leads.resolvePeople with dry run and limits", async () => {
    const s = await space();
    const { campaign } = await seedCampaign(s.target);
    const people = [await dana(s), await seedPerson(s.target), await seedPerson(s.target)];
    vi.mocked(resolvePeople).mockResolvedValue(people.map((person) => person.id));

    const preview = await s.call<{
      dry_run: boolean;
      preview: Record<string, unknown>;
      warnings: string[];
    }>("campaigns.enroll", {
      campaign_id: campaign.id,
      list_id: "ls_01k6a3v0q8x3m2n4p5r6s7t8v9",
      max: 2,
      dry_run: true,
    });
    expect(preview).toMatchObject({ dry_run: true, preview: { requested: 2, enrolled: 2 } });
    expect(preview.warnings[0]).toContain("3 people matched");
    expect(vi.mocked(resolvePeople).mock.calls[0]?.[1]).toEqual({
      listId: "ls_01k6a3v0q8x3m2n4p5r6s7t8v9",
    });
    expect(
      await engine.db.select().from(enrollments).where(eq(enrollments.campaign_id, campaign.id)),
    ).toEqual([]);

    const done = await s.call<{ enrolled: number; enrollment_ids: string[] }>("campaigns.enroll", {
      campaign_id: campaign.id,
      person_ids: people.map((person) => person.id),
    });
    expect(done.enrolled).toBe(3);

    const listed = await s.call<{ items: Array<{ person_name: string; status: string }> }>(
      "campaigns.enrollments",
      { campaign_id: campaign.id },
    );
    expect(listed.items.map((item) => item.status)).toEqual(["queued", "queued", "queued"]);
    expect(listed.items.map((item) => item.person_name)).toContain("Dana Reyes");

    const removed = await s.call("campaigns.unenroll", {
      campaign_id: campaign.id,
      person_ids: [people[0]?.id, "pe_01k6a3v0q8x3m2n4p5r6s7t8v9"],
    });
    expect(removed).toMatchObject({ stopped: 1, not_running: 1 });
  });

  it("asks who to enroll", async () => {
    const s = await space();
    const { campaign } = await seedCampaign(s.target);
    await expect(s.call("campaigns.enroll", { campaign_id: campaign.id })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("lifecycle", () => {
  it("returns a checklist with fixes and refuses to launch while something fails", async () => {
    const s = await space({ company: { name: "", postal_address: "" } });
    const created = await s.call<Detail>("campaigns.create", {
      name: "Not ready",
      steps: [{ type: "email" }],
    });
    const dry = await s.call<{
      preview: { ready: boolean; items: Array<{ key: string; status: string; fix?: string }> };
      warnings: string[];
    }>("campaigns.launch", { campaign_id: created.id, dry_run: true });
    const status = Object.fromEntries(dry.preview.items.map((item) => [item.key, item.status]));
    expect(dry.preview.ready).toBe(false);
    expect(status).toMatchObject({
      steps_valid: "pass",
      mailboxes: "fail",
      content_source: "fail",
      enrollment_source: "warn",
      postal_address: "fail",
      company_name: "warn",
    });
    expect(dry.preview.items.find((item) => item.key === "mailboxes")?.fix).toContain(
      "senders.mailbox_ids",
    );
    await expect(s.call("campaigns.launch", { campaign_id: created.id })).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("manage_mailboxes"),
    });
  });

  it("launches, pauses, resumes and stops", async () => {
    const s = await space();
    const created = await s.call<Detail>("campaigns.create", {
      name: "Lifecycle",
      steps: [{ type: "email", config: { style: "exact", subject: "hi", body: "Hi, a look?" } }],
      settings: { senders: { mailbox_ids: [s.mailboxId] } },
    });
    const person = await seedPerson(s.target);
    await s.call("campaigns.enroll", { campaign_id: created.id, person_ids: [person.id] });
    expect(await s.call("campaigns.launch", { campaign_id: created.id })).toMatchObject({
      status: "active",
      ready: true,
    });
    expect(await s.call("campaigns.pause", { campaign_id: created.id })).toMatchObject({
      status: "paused",
    });
    expect(await s.call("campaigns.resume", { campaign_id: created.id })).toMatchObject({
      status: "active",
    });
    expect(await s.call("campaigns.stop", { campaign_id: created.id })).toMatchObject({
      status: "completed",
      stopped_enrollments: 1,
    });
    await expect(s.call("campaigns.launch", { campaign_id: created.id })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await s.call("campaigns.archive", { campaign_id: created.id })).toMatchObject({
      status: "archived",
    });
  });

  it("keeps a comment step always reviewed until a person approves following the level", async () => {
    const s = await space();
    const created = await s.call<Detail>("campaigns.create", {
      name: "Comments",
      steps: [{ type: "linkedin_comment", config: { instruction: "Comment on their post." } }],
      settings: { review_level: "unsure" },
    });
    const agent = engine.principal({
      type: "agent",
      id: "key_comment_agent",
      name: "Comment agent",
      scopes: ["read", "write", "send", "spend"],
    });
    const stepOf = async () => {
      const [row] = await engine.db
        .select()
        .from(campaign_steps)
        .where(eq(campaign_steps.campaign_id, created.id));
      if (!row) throw new Error("step missing");
      return row;
    };
    const switchTo = (review: string, by?: typeof agent) =>
      engine.call(
        "campaigns.update",
        {
          campaign_id: created.id,
          steps: [
            {
              type: "linkedin_comment",
              config: { instruction: "Comment briefly on their post.", review },
            },
          ],
        },
        { workspace: s.slug, ...(by ? { principal: by } : {}) },
      ) as Promise<Record<string, unknown>>;

    const asked = await switchTo("level", agent);
    expect(asked.status).toBe("awaiting_approval");
    // The rest of the change applies; the step keeps always.
    const held = await stepOf();
    expect(held.config).toMatchObject({
      instruction: "Comment briefly on their post.",
      review: "always",
    });
    const [approval] = await engine.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, String(asked.approval_id)));
    expect(approval).toMatchObject({
      kind: "review_level",
      target_type: "campaign_step",
      target_id: held.id,
      payload: { step_id: held.id, review: "level", current: "always" },
    });
    // It switches the step it names to level, nothing else.
    const edited = await s.call<{ results: Array<Record<string, unknown>> }>("approvals.decide", {
      approval_id: asked.approval_id,
      decision: "edit",
      edits: { review_level: "unsure" },
    });
    expect(edited.results[0]).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    const decided = await s.call<{ results: Array<Record<string, unknown>> }>("approvals.decide", {
      approval_id: asked.approval_id,
      decision: "approve",
    });
    expect(decided.results[0]).toMatchObject({ ok: true, status: "approved" });
    expect((await stepOf()).config).toMatchObject({ review: "level" });

    // A person switches it directly.
    expect(await switchTo("always")).not.toHaveProperty("approval_id");
    expect((await stepOf()).config).toMatchObject({ review: "always" });
    expect(await switchTo("level")).not.toHaveProperty("approval_id");
    expect((await stepOf()).config).toMatchObject({ review: "level" });
  });

  it("launches only the campaign the launch request showed", async () => {
    const s = await space();
    const created = await s.call<Detail>("campaigns.create", {
      name: "Shown launch",
      steps: [{ type: "email", config: { style: "exact", subject: "hi", body: "Hi, a look?" } }],
      settings: { senders: { mailbox_ids: [s.mailboxId] }, daily_new_leads: 5 },
    });
    const person = await seedPerson(s.target);
    await s.call("campaigns.enroll", { campaign_id: created.id, person_ids: [person.id] });
    const agent = engine.principal({
      type: "agent",
      id: "key_launch_agent",
      name: "Launch agent",
      scopes: ["read", "write", "send", "spend"],
    });
    const asAgent = (op: string, input: unknown) =>
      engine.call(op, input, { workspace: s.slug, principal: agent }) as Promise<
        Record<string, unknown>
      >;
    const asked = await asAgent("campaigns.launch", { campaign_id: created.id });
    expect(asked.status).toBe("awaiting_approval");

    // While it waits, the agent raises the pace: the person never saw that.
    await asAgent("campaigns.update", {
      campaign_id: created.id,
      settings: { daily_new_leads: 150 },
    });
    const stale = await s.call<{ results: Array<Record<string, unknown>> }>("approvals.decide", {
      approval_id: asked.approval_id,
      decision: "approve",
    });
    expect(stale.results[0]).toMatchObject({
      ok: false,
      status: "pending",
      error: { code: "conflict", message: expect.stringContaining("changed since") },
    });
    const [draft] = await engine.db.select().from(campaigns).where(eq(campaigns.id, created.id));
    expect(draft?.status).toBe("draft");

    // Asked again, the request shows the campaign as it is now and replaces the old one.
    const again = await asAgent("campaigns.launch", { campaign_id: created.id });
    expect(again.approval_id).not.toBe(asked.approval_id);
    const [old] = await engine.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, String(asked.approval_id)));
    expect(old?.status).toBe("cancelled");
    const fresh = await s.call<{ results: Array<Record<string, unknown>> }>("approvals.decide", {
      approval_id: again.approval_id,
      decision: "approve",
    });
    expect(fresh.results[0]).toMatchObject({ ok: true, status: "approved" });
    const [active] = await engine.db.select().from(campaigns).where(eq(campaigns.id, created.id));
    expect(active?.status).toBe("active");
  });
});

describe("messages", () => {
  async function draftSetup() {
    const s = await space();
    const created = await s.call<Detail>("campaigns.create", {
      name: "Messages",
      steps: [{ type: "email", config: { style: "free", max_words: 60 } }],
      settings: { senders: { mailbox_ids: [s.mailboxId] }, writing: { instructions: "Be brief." } },
    });
    const person = await dana(s);
    const enrollment = await seedEnrollment(s.target, {
      campaign_id: created.id,
      person_id: person.id,
      status: "waiting_review",
    });
    const message = await seedMessage(s.target, {
      campaign_id: created.id,
      enrollment_id: enrollment.id,
      person_id: person.id,
      step_id: created.steps[0]?.id,
      status: "pending_review",
      subject: "round rock front desk",
      body_text: "Hi Dana, short note about the lunch rush. Worth a look?",
      why: { angle: "Coverage", signal_ids: [], signal_keys: [] },
      check: { passed: true, verdict: "pass", confidence: 0.9, issues: [] },
    } as Parameters<typeof seedMessage>[1]);
    const ctx = await engine.systemContext(s.id);
    const { id: approvalId } = await ctx.approvals.request({
      kind: "message",
      title: "Email to Dana Reyes",
      summary: "Review",
      payload: { message_id: message.id, subject: message.subject, body: message.body_text },
      target: { type: "message", id: message.id },
    });
    return { s, created, person, enrollment, message, approvalId };
  }

  it("lists and gets messages with the pending approval", async () => {
    const { s, created, message, approvalId } = await draftSetup();
    const list = await s.call<{ items: Array<Record<string, unknown>> }>("messages.list", {
      campaign_id: created.id,
      status: ["pending_review"],
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty("body_text");
    const got = await s.call("messages.get", { message_id: message.id });
    expect(got).toMatchObject({
      id: message.id,
      approval_id: approvalId,
      body_text: message.body_text,
      why: { angle: "Coverage" },
    });
  });

  it("edits a draft, re-checks it and updates the approval payload", async () => {
    const { s, message, approvalId } = await draftSetup();
    const edited = await s.call<{
      body_text: string;
      check: { passed: boolean; issues: unknown[] };
      why: { original: unknown };
    }>("messages.update", {
      message_id: message.id,
      body: "Hi Dana, act now! Click here https://example.com",
    });
    expect(edited.check.passed).toBe(false);
    expect(edited.why.original).toEqual({
      subject: "round rock front desk",
      body: "Hi Dana, short note about the lunch rush. Worth a look?",
    });
    const [approval] = await engine.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.payload).toMatchObject({
      body: "Hi Dana, act now! Click here https://example.com",
      check: { passed: false },
    });
  });

  it("regenerates with an instruction and cancels the stale approval", async () => {
    const { s, message, approvalId } = await draftSetup();
    const result = await s.call<{ status: string; job_id: string }>("messages.regenerate", {
      message_id: message.id,
      instruction: "Lead with the new location.",
    });
    expect(result.status).toBe("generating");
    const [approval] = await engine.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.status).toBe("cancelled");
    await engine.runJobs({ schedules: false });
    const [row] = await engine.db.select().from(messages).where(eq(messages.id, message.id));
    expect(row).toMatchObject({ status: "draft", body_text: DRAFT });
    const call = brain.calls.filter((entry) => entry.promptId === "campaign.email.write").at(-1);
    expect((call?.vars as { instructions: string[] } | undefined)?.instructions).toContain(
      "Also: Lead with the new location.",
    );
    expect(result.job_id).toMatch(/^job_/);
  });

  it("cancels unsent messages and refuses sent ones", async () => {
    const { s, message, approvalId } = await draftSetup();
    expect(await s.call("messages.cancel", { message_id: message.id })).toMatchObject({
      status: "cancelled",
    });
    const [approval] = await engine.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.status).toBe("cancelled");
    const sent = await seedMessage(s.target, { campaign_id: message.campaign_id, status: "sent" });
    await expect(s.call("messages.cancel", { message_id: sent.id })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      s.call("messages.update", { message_id: sent.id, body: "Changed" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("preview and teach", () => {
  it("previews drafts with why and checks for sample leads and stores nothing", async () => {
    const s = await space();
    const created = await s.call<Detail>("campaigns.create", {
      name: "Preview",
      steps: [
        { type: "linkedin_visit" },
        { type: "email", config: { style: "free", instruction: "Lead with their news." } },
      ],
      settings: { senders: { mailbox_ids: [s.mailboxId] } },
    });
    const person = await dana(s);
    const noEmail = await seedPerson(s.target, { email: null, fit_score: 10 });
    const before = (await engine.db.select().from(messages)).length;

    const dry = await s.call<{ preview: { people: Array<{ id: string }> } }>("campaigns.preview", {
      campaign_id: created.id,
      person_ids: [person.id],
      dry_run: true,
    });
    expect(dry.preview.people.map((row) => row.id)).toEqual([person.id]);

    const result = await s.call<{
      step: { position: number; type: string };
      items: Array<Record<string, unknown>>;
    }>("campaigns.preview", { campaign_id: created.id, person_ids: [person.id, noEmail.id] });
    expect(result.step).toMatchObject({ position: 1, type: "email" });
    expect(result.items[0]).toMatchObject({
      person: { id: person.id, name: "Dana Reyes", company: "Harbor Dental" },
      subject: "round rock front desk",
      body: DRAFT,
      why: { angle: "Coverage while the new clinic ramps up", facts: [], signals: [] },
      check: { verdict: "pass", issues: [] },
      skipped_reason: null,
    });
    expect(result.items[1]).toMatchObject({ person: { id: noEmail.id } });
    expect((await engine.db.select().from(messages)).length).toBe(before);
    expect(
      await engine.db.select().from(enrollments).where(eq(enrollments.campaign_id, created.id)),
    ).toEqual([]);
  });

  it("turns corrections and edited drafts into new campaign rules", async () => {
    const s = await space();
    const created = await s.call<Detail>("campaigns.create", {
      name: "Teach",
      steps: [{ type: "email" }],
      settings: { writing: { rules: ["Never mention funding rounds."] } },
    });
    const edited = await seedMessage(s.target, {
      campaign_id: created.id,
      subject: "front desk",
      body_text: "Short and plain.",
      why: {
        original: { subject: "Quick Question For You", body: "Long and salesy!" },
        notes: "edited",
      },
    } as Parameters<typeof seedMessage>[1]);
    const taught = await s.call<{ rules_added: string[]; rules: string[] }>("campaigns.teach", {
      campaign_id: created.id,
      corrections: [{ note: "Subjects read like headlines." }],
      message_ids: [edited.id],
    });
    expect(taught.rules_added).toEqual(["Keep subjects under four words."]);
    expect(taught.rules).toEqual([
      "Never mention funding rounds.",
      "Keep subjects under four words.",
    ]);
    const teachCall = brain.calls.filter((entry) => entry.promptId === "campaign.teach").at(-1);
    expect(JSON.stringify(teachCall?.vars)).toContain("Long and salesy!");
    const [row] = await engine.db
      .select({ settings: campaigns.settings })
      .from(campaigns)
      .where(eq(campaigns.id, created.id));
    expect(row?.settings).toMatchObject({
      writing: { rules: ["Never mention funding rounds.", "Keep subjects under four words."] },
    });
    // The new rules are a recorded campaign change, like any other edit.
    const logged = await engine.db
      .select()
      .from(change_log)
      .where(and(eq(change_log.workspace_id, s.id), eq(change_log.target_id, created.id)));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      area: "campaign",
      operation: "campaigns.teach",
      diff: [
        {
          path: "settings.writing.rules",
          before: ["Never mention funding rounds."],
          after: ["Never mention funding rounds.", "Keep subjects under four words."],
        },
      ],
    });

    await expect(
      s.call("campaigns.teach", { campaign_id: created.id, corrections: [{}] }),
    ).rejects.toMatchObject({ code: "validation_failed" });

    // An archived campaign cannot change, so it is refused before any AI call.
    await engine.db
      .update(campaigns)
      .set({ status: "archived" })
      .where(eq(campaigns.id, created.id));
    const calls = brain.calls.length;
    await expect(
      s.call("campaigns.teach", {
        campaign_id: created.id,
        corrections: [{ note: "Shorter subjects." }],
      }),
    ).rejects.toMatchObject({ code: "conflict", hint: expect.stringContaining("duplicate") });
    expect(brain.calls.length).toBe(calls);
  });
});

describe("campaigns.list and get", () => {
  it("lists campaigns by status and name with counters", async () => {
    const s = await space();
    await seedCampaign(s.target, { name: "Alpha dental", status: "active" });
    await seedCampaign(s.target, { name: "Beta legal", status: "draft" });
    const active = await s.call<{ items: Array<{ name: string; step_count: number }> }>(
      "campaigns.list",
      { status: ["active"] },
    );
    expect(active.items.map((item) => [item.name, item.step_count])).toEqual([["Alpha dental", 1]]);
    const byName = await s.call<{ items: Array<{ name: string }> }>("campaigns.list", {
      query: "legal",
    });
    expect(byName.items.map((item) => item.name)).toEqual(["Beta legal"]);
    const steps = await engine.db
      .select()
      .from(campaign_steps)
      .where(and(eq(campaign_steps.workspace_id, s.id)));
    expect(steps).toHaveLength(2);
  });
});
