import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { definePrompt } from "../brain/prompt.js";
import { parseWorkspaceSettings } from "../core/settings.js";
import { approvals, secrets } from "../db/schema/index.js";
import type { EmailVerifierProvider } from "../providers/types.js";
import { createTestContext, type TestContext } from "./context.js";
import { seedPerson, seedWorkspace } from "./factories.js";

const contexts: TestContext[] = [];
async function make(...args: Parameters<typeof createTestContext>) {
  const ctx = await createTestContext(...args);
  contexts.push(ctx);
  return ctx;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.close()));
});

const classify = definePrompt({
  id: "inbox.classify_reply",
  version: 1,
  tier: "fast",
  system: () => "Classify the reply.",
  user: (vars: { text: string }) => `Reply: ${vars.text}`,
  schema: z.object({
    category: z.enum(["interested", "not_now", "other"]),
    confidence: z.number().min(0).max(1),
    return_date: z.iso.date().nullable(),
    notes: z.string().optional(),
  }),
});

describe("createTestContext", () => {
  it("seeds a workspace, principal, clock and request", async () => {
    const ctx = await make({ sandbox: true, settings: { ai: { monthly_budget_usd: 10 } } });
    expect(ctx.workspace.id).toMatch(/^ws_/);
    expect(ctx.workspace.is_sandbox).toBe(true);
    expect(parseWorkspaceSettings(ctx.workspace.settings).ai.monthly_budget_usd).toBe(10);
    expect(ctx.principal).toMatchObject({
      type: "human",
      workspaceId: ctx.workspace.id,
      via: "cli",
    });
    expect(ctx.principal.scopes).toContain("approve");
    expect(ctx.clock.now().toISOString()).toBe("2026-09-19T12:00:00.000Z");
    ctx.clock.advanceBy({ hours: 2 });
    expect(ctx.clock.now().toISOString()).toBe("2026-09-19T14:00:00.000Z");
    expect(ctx.request).toEqual({ dryRun: false, responseFormat: "concise" });
    expect(ctx.config.database).toEqual({ kind: "memory" });
  });

  it("records jobs with singleton dedupe", async () => {
    const ctx = await make();
    const first = await ctx.jobs.enqueue(
      "research.run",
      { company_id: "co_1" },
      { singletonKey: "r:co_1" },
    );
    const again = await ctx.jobs.enqueue(
      "research.run",
      { company_id: "co_1" },
      { singletonKey: "r:co_1" },
    );
    expect(again).toEqual({ job_id: first.job_id, status: "queued", deduplicated: true });
    expect(ctx.enqueued("research.run")).toHaveLength(1);
    expect((await ctx.jobs.get(first.job_id))?.name).toBe("research.run");
    expect(await ctx.jobs.cancel(first.job_id)).toBe(true);
    await ctx.jobs.wake("task:abc");
    expect(ctx.recorded.wakes).toEqual(["task:abc"]);
  });

  it("records events and audit entries with defaults", async () => {
    const ctx = await make();
    await ctx.events.emit("campaign.launched", {
      subject: { type: "campaign", id: "cmp_1" },
      data: { campaign_id: "cmp_1", name: "Q4" },
    });
    expect(ctx.emitted("campaign.launched")[0]?.data.name).toBe("Q4");
    await ctx.audit.record({ operation: "campaigns.launch", effect: "send", status: "ok" });
    expect(ctx.recorded.audit[0]).toMatchObject({
      workspaceId: ctx.workspace.id,
      actor: { type: "human", id: "usr_test" },
      via: "cli",
    });
  });

  it("approvals insert a real row, record, and emit approval.requested", async () => {
    const ctx = await make();
    const { id } = await ctx.approvals.request({
      kind: "message",
      title: "Send email to Dana",
      summary: "First touch",
      payload: { message_id: "msg_1" },
      target: { type: "message", id: "msg_1" },
    });
    const [row] = await ctx.db.select().from(approvals).where(eq(approvals.id, id));
    expect(row).toMatchObject({ status: "pending", kind: "message", target_id: "msg_1" });
    expect(row?.expires_at?.toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(ctx.recorded.approvals).toHaveLength(1);
    expect(ctx.emitted("approval.requested")[0]?.data.approval_id).toBe(id);
    expect(await ctx.approvals.cancel({ target: { type: "message", id: "msg_1" } })).toBe(1);
  });

  it("usage passes budgets unless configured", async () => {
    const ctx = await make({ overBudget: ["data"] });
    await expect(ctx.usage.assertBudget(ctx.workspace.id, "ai")).resolves.toBeUndefined();
    await expect(ctx.usage.assertBudget(ctx.workspace.id, "data")).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    ctx.usage.setOverBudget("data", false);
    await ctx.usage.record({
      slot: "email_finder",
      provider: "icypeas",
      operation: "enrichment.run",
      credits: 2,
    });
    expect(await ctx.usage.monthToDate(ctx.workspace.id)).toMatchObject({ dataCredits: 2 });
  });

  it("usage refuses a used-up budget with the same numbers and hint as the real meter", async () => {
    const ctx = await make({
      overBudget: ["data", "ai"],
      settings: { data: { monthly_credit_budget: 10 }, ai: { monthly_budget_usd: 5 } },
    });
    await expect(ctx.usage.assertBudget(ctx.workspace.id, "data")).rejects.toMatchObject({
      code: "budget_exceeded",
      message: "The monthly data budget is used up (10 of 10 credits).",
      hint: "Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
      details: {
        kind: "data",
        used: 10,
        budget: 10,
        setting: "settings.data.monthly_credit_budget",
      },
    });
    await expect(ctx.usage.assertBudget(ctx.workspace.id, "ai")).rejects.toMatchObject({
      message: "The monthly AI budget is used up (5 of 5 USD).",
      hint: "Wait until next month, or ask the human to raise settings.ai.monthly_budget_usd (openoutbound workspaces update).",
    });
  });

  it("usage over budget in one workspace does not block another", async () => {
    const ctx = await make();
    const other = ctx.with({ workspace: await seedWorkspace(ctx.db) });
    other.usage.setOverBudget("data");
    await expect(other.usage.assertBudget(other.workspace.id, "data")).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    await expect(ctx.usage.assertBudget(ctx.workspace.id, "data")).resolves.toBeUndefined();
    expect((await ctx.usage.budgetStatus(ctx.workspace.id, "data")).remaining).toBeNull();
    expect((await ctx.usage.budgetStatus(other.workspace.id, "data")).remaining).toBe(0);
    // The switch belongs to the workspace, whichever context asks.
    await expect(ctx.usage.assertBudget(other.workspace.id, "data")).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    ctx.usage.setOverBudget("ai", true, other.workspace.id);
    await expect(other.brain.run(classify, { text: "x" })).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    await expect(ctx.brain.run(classify, { text: "y" })).resolves.toBeDefined();
    other.usage.setOverBudget("data", false);
    await expect(other.usage.assertBudget(other.workspace.id, "data")).resolves.toBeUndefined();

    // overBudget at creation is for the seeded workspace only.
    const seeded = await make({ overBudget: ["ai"] });
    const second = seeded.with({ workspace: await seedWorkspace(seeded.db) });
    await expect(seeded.brain.run(classify, { text: "x" })).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    await expect(second.brain.run(classify, { text: "x" })).resolves.toBeDefined();
  });

  it("providers resolve by slot; tryGet returns null otherwise", async () => {
    const verifier: EmailVerifierProvider = {
      id: "fake_verifier",
      verify: async (email) => ({ email, status: "valid", creditsUsed: 1 }),
    };
    const ctx = await make({ providers: { email_verifier: verifier } });
    expect((await ctx.providers.get("email_verifier")).id).toBe("fake_verifier");
    expect(await ctx.providers.tryGet("lead_source")).toBeNull();
    await expect(ctx.providers.get("lead_source")).rejects.toMatchObject({
      code: "provider_not_configured",
    });
    expect(await ctx.providers.list("email_verifier")).toHaveLength(1);
  });

  it("safe fetch serves routes and throws on unmatched URLs", async () => {
    const ctx = await make({
      fetchRoutes: [
        { match: "https://harbor.example.com/", response: { body: "<h1>Harbor</h1>" } },
      ],
    });
    ctx.fetch.route(/\/api\//, { json: { ok: true } });
    expect(await (await ctx.fetch("https://harbor.example.com")).text()).toBe("<h1>Harbor</h1>");
    expect(await (await ctx.fetch("https://harbor.example.com/api/x")).json()).toEqual({
      ok: true,
    });
    await expect(ctx.fetch("https://unknown.example.com")).rejects.toThrow(/No fake fetch route/);
    expect(ctx.recorded.fetch).toHaveLength(3);
  });

  it("vault encrypts into the secrets table and scopes reads", async () => {
    const ctx = await make();
    const id = await ctx.vault.putSecret(ctx.workspace.id, "mailbox.password", "app-pass-123");
    const [row] = await ctx.db.select().from(secrets).where(eq(secrets.id, id));
    expect(row?.ciphertext).not.toContain("app-pass-123");
    expect(await ctx.vault.getSecret(id)).toBe("app-pass-123");
    expect(await ctx.vault.getSecret(id, ctx.workspace.id)).toBe("app-pass-123");
    expect(await ctx.vault.getSecret(id, null)).toBeNull();
    expect(await ctx.vault.putSecret(ctx.workspace.id, "mailbox.password", "new-pass")).toBe(id);
    expect(await ctx.vault.getSecret(id)).toBe("new-pass");
    await ctx.vault.deleteSecret(id);
    expect(await ctx.vault.getSecret(id)).toBeNull();
  });

  it("FakeBrain answers from handlers or the schema and records calls", async () => {
    const ctx = await make({
      brain: {
        "inbox.classify_reply": { category: "interested", confidence: 0.9, return_date: null },
      },
    });
    const answered = await ctx.brain.run(classify, { text: "Sounds great" });
    expect(answered.output.category).toBe("interested");
    ctx.brain.on("inbox.classify_reply", (vars: { text: string }) => ({
      category: vars.text.includes("later") ? "not_now" : "other",
      confidence: 0.5,
      return_date: null,
    }));
    expect((await ctx.brain.run(classify, { text: "later please" })).output.category).toBe(
      "not_now",
    );
    expect(ctx.recorded.brain.map((call) => call.user)).toEqual([
      "Reply: Sounds great",
      "Reply: later please",
    ]);
    expect(ctx.recorded.usage.filter((u) => u.slot === "brain")).toHaveLength(2);

    const fresh = await make();
    const sampled = await fresh.brain.run(classify, { text: "x" });
    expect(sampled.output).toEqual({ category: "interested", confidence: 0, return_date: null });
  });

  it("brain records AI usage on the workspace of the context that ran the prompt", async () => {
    const ctx = await make();
    const other = ctx.with({ workspace: await seedWorkspace(ctx.db) });
    await other.brain.run(classify, { text: "a" });
    await ctx.brain.run(classify, { text: "b" });
    await other.jobContext().brain.run(classify, { text: "c" });
    // An explicit workspace (or none) still wins, as in the real service.
    await other.brain.run(classify, { text: "d" }, { workspaceId: null });
    await ctx.brain.run(classify, { text: "e" }, { workspaceId: other.workspace.id });
    expect(ctx.recorded.usage.filter((u) => u.slot === "brain").map((u) => u.workspaceId)).toEqual([
      other.workspace.id,
      ctx.workspace.id,
      other.workspace.id,
      null,
      other.workspace.id,
    ]);
    expect(await ctx.usage.monthToDate(other.workspace.id)).toMatchObject({ aiCostUsd: 0 });

    // Answers and recorded calls stay shared between the contexts.
    other.brain.on("inbox.classify_reply", { category: "other", confidence: 1, return_date: null });
    expect((await ctx.brain.run(classify, { text: "f" })).output.category).toBe("other");
    expect(other.brain.calls).toBe(ctx.recorded.brain);
    expect(ctx.recorded.brain).toHaveLength(6);
  });

  it("brain fails like the real service when the AI budget is used up", async () => {
    const ctx = await make({ overBudget: ["ai"] });
    await expect(ctx.brain.run(classify, { text: "x" })).rejects.toMatchObject({
      code: "budget_exceeded",
    });
  });

  it("with() and jobContext() share the database and recorders", async () => {
    const ctx = await make();
    const agent = ctx.with({
      principal: { type: "agent", id: "key_1", scopes: ["read"] },
      request: { dryRun: true },
    });
    await agent.audit.record({ operation: "leads.import", effect: "write", status: "dry_run" });
    expect(ctx.recorded.audit[0]?.actor?.id).toBe("key_1");
    expect(agent.request.dryRun).toBe(true);

    const jobCtx = ctx.jobContext({ name: "research.run" });
    expect(jobCtx.principal).toMatchObject({
      type: "system",
      via: "worker",
      workspaceId: ctx.workspace.id,
    });
    await jobCtx.setProgress({ done: 1, total: 3 });
    expect(ctx.recorded.progress[0]?.progress).toEqual({ done: 1, total: 3 });
    const person = await seedPerson(jobCtx);
    expect(person.workspace_id).toBe(ctx.workspace.id);
  });

  it("shares one database across contexts when asked", async () => {
    const first = await make();
    const second = await make({ db: first.testDb });
    expect(second.workspace.id).not.toBe(first.workspace.id);
    await seedPerson(second, { email: "shared@example.com" });
    await seedPerson(first, { email: "shared@example.com" });
  });
});
