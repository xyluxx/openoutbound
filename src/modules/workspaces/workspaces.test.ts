import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_SCOPES } from "../../core/context.js";
import {
  approvals,
  change_log,
  jobs,
  notification_channels,
  usage_records,
  workspaces,
} from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { module as system } from "../system/index.js";
import { module as workspacesModule } from "./index.js";
import { slugify } from "./schemas.js";

interface WorkspaceResult {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_sandbox: boolean;
  timezone: string;
  settings?: Record<string, unknown>;
  message?: string;
}

let engine: TestEngine;

const create = (input: Record<string, unknown>, options: Record<string, unknown> = {}) =>
  engine.call("workspaces.create", input, options) as Promise<WorkspaceResult>;
const update = (input: Record<string, unknown>, workspace = "harbor-dental") =>
  engine.call("workspaces.update", input, { workspace }) as Promise<WorkspaceResult>;

beforeAll(async () => {
  engine = await createTestEngine({ modules: [workspacesModule, system] });
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  await engine.db.delete(jobs);
  await engine.db.delete(workspaces);
  await create({ name: "Harbor Dental", timezone: "America/Chicago" });
});

describe("slugs", () => {
  it("derives URL-safe slugs from names", () => {
    expect(slugify("Harbor Dental Group")).toBe("harbor-dental-group");
    expect(slugify("Café Zürich & Söhne GmbH")).toBe("cafe-zurich-sohne-gmbh");
    expect(slugify("  --  ")).toBe("workspace");
    expect(slugify("x".repeat(60))).toHaveLength(48);
  });
});

describe("workspace management", () => {
  it("creates workspaces with unique slugs and validated settings", async () => {
    const again = await create({ name: "Harbor Dental" });
    expect(again.slug).toBe("harbor-dental-2");
    const sandbox = await create({ name: "Practice", slug: "practice", is_sandbox: true });
    expect(sandbox).toMatchObject({
      slug: "practice",
      is_sandbox: true,
      timezone: "UTC",
      status: "active",
    });
    await expect(create({ name: "Other", slug: "practice" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(create({ name: "Bad zone", timezone: "Mars/Olympus" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      create({ name: "Rogue", settings: { replies: { unsubscribe: { action: "auto_reply" } } } }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "settings.replies.unsubscribe.action" },
    });
    await expect(
      create({ name: "Bad budget", settings: { ai: { monthly_budget_usd: "lots" } } }),
    ).rejects.toMatchObject({ code: "validation_failed" });

    const [harbor] = await engine.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, "harbor-dental"));
    const bound = engine.principal({ workspaceId: harbor?.id ?? null });
    await expect(create({ name: "Sneaky" }, { principal: bound })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("lists visible workspaces and hides archived ones", async () => {
    await create({ name: "Globex Logistics" });
    const old = await create({ name: "Old Client" });
    await update({ archived: true }, old.slug);
    const list = async (
      input: Record<string, unknown> = {},
      options: Record<string, unknown> = {},
    ) =>
      (
        (await engine.call("workspaces.list", input, options)) as { items: WorkspaceResult[] }
      ).items.map((item) => item.slug);
    expect(await list()).toEqual(["harbor-dental", "globex-logistics"]);
    expect(await list({ status: "archived" })).toEqual(["old-client"]);
    expect(await list({ query: "GLOB" })).toEqual(["globex-logistics"]);
    const [harbor] = await engine.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, "harbor-dental"));
    expect(
      await list({}, { principal: engine.principal({ workspaceId: harbor?.id ?? null }) }),
    ).toEqual(["harbor-dental"]);
    const restored = await update({ archived: false }, old.slug);
    expect(restored.status).toBe("active");
  });

  it("tells a caller without the admin scope to suggest a settings change instead", async () => {
    await expect(
      engine.call(
        "workspaces.update",
        { settings: { company: { name: "Harbor Dental" } } },
        { workspace: "harbor-dental", scopes: ["read", "write", "send", "spend", "approve"] },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      details: { missing_scope: "admin" },
      hint: expect.stringContaining(
        "To suggest the change instead, use manage_strategy action propose (operation workspaces.update",
      ),
    });
  });

  it("refuses someone who must ask every settings change that loosens a gate", async () => {
    await update({
      settings: { ai: { monthly_budget_usd: 50 }, data: { monthly_credit_budget: 2000 } },
    });
    // An agent key the owner gave every scope, admin and approve included.
    const agent = engine.principal({
      type: "agent",
      id: "key_admin_agent",
      name: "Admin agent",
      scopes: [...ALL_SCOPES],
    });
    const asAgent = (settings: Record<string, unknown>) =>
      engine.call(
        "workspaces.update",
        { settings },
        { workspace: "harbor-dental", principal: agent },
      );
    const refusals: Array<[Record<string, unknown>, string[]]> = [
      [
        { approvals: { agent_launch_requires_approval: false } },
        ["settings.approvals.agent_launch_requires_approval"],
      ],
      [{ approvals: { agent_changes: "auto" } }, ["settings.approvals.agent_changes"]],
      [
        { approvals: { default_review_level: "unsure" } },
        ["settings.approvals.default_review_level"],
      ],
      [{ ai: { monthly_budget_usd: 500 } }, ["settings.ai.monthly_budget_usd"]],
      [{ ai: { monthly_budget_usd: null } }, ["settings.ai.monthly_budget_usd"]],
      [{ data: { monthly_credit_budget: 1_000_000 } }, ["settings.data.monthly_credit_budget"]],
      [{ replies: { question: { action: "auto_reply" } } }, ["settings.replies.question.action"]],
      [
        {
          approvals: { agent_launch_requires_approval: false, agent_changes: "auto" },
          data: { monthly_credit_budget: 1_000_000 },
          company: { name: "Harbor Dental" },
        },
        [
          "settings.approvals.agent_launch_requires_approval",
          "settings.approvals.agent_changes",
          "settings.data.monthly_credit_budget",
        ],
      ],
    ];
    for (const [settings, fields] of refusals) {
      await expect(asAgent(settings)).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining(fields[0] ?? ""),
        details: { fields, operation: "workspaces.update" },
      });
    }
    // The hint names the proposal path, which asks a person; a budget only asks the human.
    await expect(asAgent({ approvals: { agent_changes: "auto" } })).rejects.toMatchObject({
      hint: expect.stringContaining(
        'manage_strategy action propose (operation workspaces.update, input {"settings":{"approvals":{"agent_changes":"auto"}}})',
      ),
    });
    const budget = asAgent({ ai: { monthly_budget_usd: 500 } });
    await expect(budget).rejects.toMatchObject({
      hint: expect.stringContaining(
        "ask the human to raise settings.ai.monthly_budget_usd (openoutbound workspaces update)",
      ),
    });
    await expect(budget).rejects.not.toMatchObject({ hint: expect.stringContaining("propose") });

    const unchanged = (await engine.call(
      "workspaces.get",
      {},
      { workspace: "harbor-dental", responseFormat: "detailed" },
    )) as WorkspaceResult;
    expect(unchanged.settings).toMatchObject({
      approvals: {
        agent_launch_requires_approval: true,
        agent_changes: "approve",
        default_review_level: "first",
      },
      ai: { monthly_budget_usd: 50 },
      data: { monthly_credit_budget: 2000 },
      replies: { question: { action: "draft_reply" } },
      company: { name: "" },
    });

    // Tightening, and settings that hold no gate, apply as before.
    const tightened = (await asAgent({
      approvals: { default_review_level: "every" },
      ai: { monthly_budget_usd: 20 },
      company: { name: "Harbor Dental" },
    })) as WorkspaceResult;
    expect(tightened.settings).toMatchObject({
      approvals: { default_review_level: "every" },
      ai: { monthly_budget_usd: 20 },
      company: { name: "Harbor Dental" },
    });

    // A person holding approve loosens them directly.
    const loosened = await update({
      settings: {
        approvals: { agent_launch_requires_approval: false, default_review_level: "unsure" },
        ai: { monthly_budget_usd: null },
        replies: { question: { action: "auto_reply" } },
      },
    });
    expect(loosened.settings).toMatchObject({
      approvals: { agent_launch_requires_approval: false, default_review_level: "unsure" },
      ai: { monthly_budget_usd: null },
      replies: { question: { action: "auto_reply" } },
    });

    // Nor does a new workspace start with a gate loosened by someone who must ask.
    await expect(
      engine.call(
        "workspaces.create",
        { name: "Loose Client", settings: { approvals: { agent_changes: "auto" } } },
        { principal: agent },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      details: { fields: ["settings.approvals.agent_changes"] },
    });
    const created = await create(
      { name: "Careful Client", settings: { approvals: { default_review_level: "every" } } },
      { principal: agent },
    );
    expect(created.slug).toBe("careful-client");
  });

  it("deep-merges settings and protects locked reply rules", async () => {
    await update({ settings: { ai: { monthly_budget_usd: 50 } } });
    const merged = await update({
      settings: { approvals: { expire_days: 3 }, company: { name: "Harbor Dental" } },
    });
    expect(merged.settings).toMatchObject({
      ai: { monthly_budget_usd: 50 },
      approvals: { expire_days: 3 },
      company: { name: "Harbor Dental" },
    });
    await expect(
      update({ settings: { replies: { bounce: { action: "notify" } } } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      update({ settings: { replies: { privacy_request: { action: "draft_reply" } } } }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "settings.replies.privacy_request.action" },
    });
    const booking = await update({
      settings: { booking: { mode: "handoff" }, crm: { skip_owned_accounts: true } },
    });
    expect(booking.settings).toMatchObject({
      booking: { mode: "handoff" },
      crm: { skip_owned_accounts: true },
    });
    await expect(update({ settings: { approvals: { expire_days: 365 } } })).rejects.toMatchObject({
      code: "validation_failed",
    });

    const stored = (await engine.call(
      "workspaces.get",
      {},
      { workspace: "harbor-dental" },
    )) as WorkspaceResult;
    expect(stored.settings).not.toHaveProperty("schedule");
    const effective = (await engine.call(
      "workspaces.get",
      {},
      { workspace: "harbor-dental", responseFormat: "detailed" },
    )) as WorkspaceResult;
    expect(effective.settings).toMatchObject({
      approvals: { expire_days: 3 },
      sandbox: { use_real_brain: false },
    });

    await create({ name: "Globex" });
    await expect(update({ slug: "globex" })).rejects.toMatchObject({ code: "conflict" });
    const renamed = await update({ slug: "harbor", name: "Harbor Dental Group" });
    expect(renamed).toMatchObject({ slug: "harbor", name: "Harbor Dental Group" });
  });

  it("merges concurrent settings updates into what is stored, recorded from the locked read", async () => {
    const first = await update({ settings: { ai: { monthly_budget_usd: 50 } } });
    await Promise.all([
      update({ settings: { strategy: { goals: "Ten demos a month" } } }),
      update({ settings: { booking: { mode: "handoff" } } }),
      update({ settings: { ai: { monthly_budget_usd: 80 } } }),
      update({ name: "Harbor Dental Group" }),
    ]);
    const [row] = await engine.db.select().from(workspaces).where(eq(workspaces.id, first.id));
    expect(row?.name).toBe("Harbor Dental Group");
    expect(row?.settings).toEqual({
      ai: { monthly_budget_usd: 80 },
      strategy: { goals: "Ten demos a month" },
      booking: { mode: "handoff" },
    });
    const logged = await engine.db
      .select()
      .from(change_log)
      .where(eq(change_log.workspace_id, first.id))
      .orderBy(asc(change_log.version));
    // Every change names only its own path: its "before" is what was stored when it ran.
    const concurrent = logged.slice(1);
    expect(concurrent.map((entry) => entry.diff.map((item) => item.path).join()).sort()).toEqual([
      "ai.monthly_budget_usd",
      "booking.mode",
      "strategy.goals",
    ]);
    expect(
      concurrent.find((entry) => entry.diff[0]?.path === "ai.monthly_budget_usd")?.diff,
    ).toEqual([{ path: "ai.monthly_budget_usd", before: 50, after: 80 }]);
  });

  it("pauses and resumes sending with the right scopes and a notification", async () => {
    await engine.call(
      "notifications.create",
      { type: "webhook", name: "Ops", url: "https://hooks.example.com/ops" },
      { workspace: "harbor-dental" },
    );
    const paused = (await engine.call(
      "workspaces.pause",
      {},
      { workspace: "harbor-dental", reason: "Bounce spike" },
    )) as WorkspaceResult;
    expect(paused).toMatchObject({ status: "paused", message: expect.stringContaining("paused") });
    const [delivery] = await engine.db
      .select()
      .from(jobs)
      .where(eq(jobs.name, "notifications.deliver"));
    expect(delivery?.payload).toMatchObject({
      message: {
        title: "Sending paused in Harbor Dental",
        lines: ["Paused by Test Admin.", "Reason: Bounce spike"],
        severity: "warning",
      },
    });
    await expect(
      engine.call("workspaces.pause", {}, { workspace: "harbor-dental" }),
    ).resolves.toMatchObject({ message: "The workspace was already paused." });

    await expect(
      engine.call(
        "workspaces.resume",
        {},
        { workspace: "harbor-dental", scopes: ["read", "write"] },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      engine.call("workspaces.resume", {}, { workspace: "harbor-dental" }),
    ).resolves.toMatchObject({ status: "active", message: "Sending resumed." });
    await engine.db.delete(notification_channels);
  });

  it("reports setup progress, providers, warnings and attention counts", async () => {
    const [harbor] = await engine.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, "harbor-dental"));
    if (!harbor) throw new Error("no workspace");
    const status = async () =>
      (await engine.call("workspaces.status", {}, { workspace: "harbor-dental" })) as {
        ready: boolean;
        setup: {
          done: number;
          total: number;
          next_step: string | null;
          items: Array<{ key: string; done: boolean }>;
        };
        providers: Array<{ slot: string; configured: boolean }>;
        warnings: Array<{ code: string }>;
        attention: { pending_approvals: number; approvals_by_kind: Record<string, number> };
        usage: { month: string };
      };
    const fresh = await status();
    expect(fresh.ready).toBe(false);
    expect(fresh.setup.items.map((item) => item.key)).toEqual([
      "company",
      "brain",
      "knowledge",
      "offer",
      "icp",
      "senders",
      "leads",
      "campaign",
      "postal_address",
    ]);
    expect(fresh.setup.next_step).toContain("settings.company.name");
    expect(fresh.providers).toHaveLength(9);
    expect(fresh.warnings).toEqual([]);
    expect(fresh.usage.month).toBe("2026-09");

    await update({
      settings: {
        company: { name: "Harbor Dental", website: "https://harbor.example.com" },
      },
    });
    await engine.db.insert(approvals).values({
      workspace_id: harbor.id,
      kind: "message",
      title: "Send email",
      summary: "First touch",
      payload: {},
    });
    await engine.call("workspaces.pause", {}, { workspace: "harbor-dental" });
    const later = await status();
    expect(later.setup.items.find((item) => item.key === "company")?.done).toBe(true);
    expect(later.setup.next_step).toContain("providers set --slot brain");
    expect(later.warnings.map((warning) => warning.code)).toContain("workspace_paused");
    expect(later.attention).toMatchObject({
      pending_approvals: 1,
      approvals_by_kind: { message: 1 },
    });
    await engine.db.delete(approvals);
  });

  it("warns about budgets near or at their limit, with where to raise them", async () => {
    const harbor = await update({
      settings: { data: { monthly_credit_budget: 10 }, ai: { monthly_budget_usd: 5 } },
    });
    await engine.db.insert(usage_records).values([
      {
        workspace_id: harbor.id,
        slot: "lead_source",
        provider: "apollo",
        operation: "leads.find",
        credits: 10,
        created_at: engine.clock.now(),
      },
      {
        workspace_id: harbor.id,
        slot: "brain",
        provider: "anthropic",
        operation: "research.run",
        cost_usd: 4.5,
        created_at: engine.clock.now(),
      },
    ]);
    const status = (await engine.call("workspaces.status", {}, { workspace: "harbor-dental" })) as {
      warnings: Array<{ code: string; message: string; hint?: string }>;
    };
    expect(status.warnings).toEqual(
      expect.arrayContaining([
        {
          code: "ai_budget_80",
          message: "AI spend this month is $4.50 of $5.",
          hint: "Use cheaper models (settings.ai.task_models), or ask the human to raise settings.ai.monthly_budget_usd (openoutbound workspaces update).",
        },
        {
          code: "data_budget_exceeded",
          message: "Data credits this month: 10 of 10.",
          hint: "Narrow searches before enriching, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
        },
      ]),
    );
  });
});
