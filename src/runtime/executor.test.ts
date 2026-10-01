import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { budgetWarning } from "../core/budget.js";
import { type Principal, requireWorkspace } from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  dryRun,
  dryRunOutput,
  type EngineModule,
} from "../core/operation.js";
import {
  audit_events,
  idempotency_records,
  usage_records,
  type Workspace,
  workspaces,
} from "../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";

const calls: Record<string, number> = {};
const bump = (id: string) => {
  calls[id] = (calls[id] ?? 0) + 1;
  return calls[id];
};

const demo: EngineModule = {
  name: "demo",
  operations: [
    defineOperation({
      id: "demo.read",
      summary: "Read",
      description: "Reads.",
      effect: "read",
      input: z.object({}).strict(),
      output: z.object({ workspace: z.string(), format: z.string(), dry: z.boolean() }),
      dryRun: "none",
      idempotent: true,
      workspace: "required",
      examples: [],
      handler: async (ctx) => ({
        workspace: ctx.workspace?.slug ?? "",
        format: ctx.request.responseFormat,
        dry: ctx.request.dryRun,
      }),
    }),
    defineOperation({
      id: "demo.write",
      summary: "Write",
      description: "Writes.",
      effect: "write",
      input: z.object({ name: z.string().min(1), api_key: z.string().optional() }).strict(),
      output: z.union([
        z.object({ name: z.string(), calls: z.number(), reason: z.string().nullable() }),
        dryRunOutput(z.object({ name: z.string() })),
      ]),
      dryRun: "supported",
      idempotent: true,
      workspace: "required",
      examples: [{ title: "Write", input: { name: "Harbor" } }],
      handler: async (ctx, input) => {
        if (ctx.request.dryRun) return dryRun({ name: input.name });
        return { name: input.name, calls: bump("demo.write"), reason: ctx.request.reason ?? null };
      },
    }),
    defineOperation({
      id: "demo.send",
      summary: "Send",
      description: "Sends.",
      effect: "send",
      input: z.object({}),
      output: z.union([
        z.object({ sent: z.boolean() }),
        dryRunOutput(z.object({ to: z.string() })),
      ]),
      dryRun: "default",
      idempotent: false,
      workspace: "required",
      examples: [],
      handler: async (ctx) =>
        ctx.request.dryRun ? dryRun({ to: "dana@example.com" }) : { sent: true },
    }),
    defineOperation({
      id: "demo.spend",
      summary: "Spend",
      description: "Spends.",
      effect: "spend",
      input: z.object({}),
      output: z.object({ spent: z.boolean() }),
      dryRun: "none",
      idempotent: false,
      workspace: "required",
      examples: [],
      handler: async () => ({ spent: true }),
    }),
    defineOperation({
      id: "demo.spend_preview",
      summary: "Spend with a preview",
      description: "Spends credits, with a dry run that warns like the real spend operations.",
      effect: "spend",
      input: z.object({ credits: z.number().default(0) }),
      output: z.union([
        z.object({ spent: z.boolean() }),
        dryRunOutput(z.object({ credits: z.number() })),
      ]),
      dryRun: "supported",
      idempotent: false,
      workspace: "required",
      examples: [],
      handler: async (ctx, input) => {
        if (!ctx.request.dryRun) return { spent: true };
        const status = await ctx.usage.budgetStatus(requireWorkspace(ctx).id, "data");
        const warning = budgetWarning(status, input.credits);
        return dryRun(
          { credits: input.credits },
          { warnings: ["Checked the inputs.", ...(warning ? [warning] : [])] },
        );
      },
    }),
    defineOperation({
      id: "demo.fail",
      summary: "Fail",
      description: "Fails.",
      effect: "write",
      input: z.object({ n: z.number().optional() }),
      output: z.object({ ok: z.boolean() }),
      dryRun: "none",
      idempotent: true,
      workspace: "required",
      examples: [],
      handler: async () => {
        bump("demo.fail");
        throw new OpenOutboundError("conflict", "Nope.", { hint: "Try later." });
      },
    }),
    defineOperation({
      id: "demo.bad_output",
      summary: "Bad output",
      description: "Returns the wrong shape.",
      effect: "read",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      dryRun: "none",
      idempotent: true,
      workspace: "none",
      boundPrincipals: "allow",
      examples: [],
      handler: async () => ({ wrong: 1 }) as never,
    }),
    defineOperation({
      id: "demo.instance_write",
      summary: "Instance write",
      description: "Changes the whole instance.",
      effect: "write",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      dryRun: "none",
      idempotent: true,
      workspace: "none",
      boundPrincipals: "refuse",
      examples: [],
      handler: async () => ({ ok: bump("demo.instance_write") > 0 }),
    }),
    defineOperation({
      id: "demo.instance_read",
      summary: "Instance read",
      description: "Reads what the caller may see.",
      effect: "read",
      input: z.object({}),
      output: z.object({ bound_to: z.string().nullable() }),
      dryRun: "none",
      idempotent: true,
      workspace: "none",
      boundPrincipals: "allow",
      examples: [],
      handler: async (ctx) => ({ bound_to: ctx.principal.workspaceId }),
    }),
    defineOperation({
      id: "demo.optional",
      summary: "Optional",
      description: "Optional workspace.",
      effect: "read",
      input: z.object({}),
      output: z.object({ workspace: z.string().nullable() }),
      dryRun: "none",
      idempotent: true,
      workspace: "optional",
      examples: [],
      handler: async (ctx) => ({ workspace: ctx.workspace?.slug ?? null }),
    }),
    defineOperation({
      id: "demo.gate",
      summary: "Gated",
      description: "Needs approval.",
      effect: "write",
      input: z.object({}),
      output: awaitingApprovalOutput,
      dryRun: "none",
      idempotent: false,
      workspace: "required",
      examples: [],
      handler: async (ctx) => {
        const { id } = await ctx.approvals.request({
          kind: "custom",
          title: "Do it",
          summary: "Will do it",
          payload: {},
        });
        return awaitingApproval(id, "Waiting for a human");
      },
    }),
    defineOperation({
      id: "demo.erase",
      summary: "Erase",
      description: "Erases an address; the audit log never keeps it.",
      effect: "destructive",
      input: z.object({ email: z.string().email(), person_id: z.string().optional() }),
      output: z.object({ erased: z.boolean() }),
      dryRun: "none",
      idempotent: true,
      workspace: "required",
      examples: [],
      auditInput: (input) => ({ ...input, email: "[erased]" }),
      handler: async () => ({ erased: true }),
    }),
  ],
};

let engine: TestEngine;
let alpha: Workspace;
let beta: Workspace;

async function insertWorkspace(slug: string, extra: Partial<Workspace> = {}): Promise<Workspace> {
  const [row] = await engine.db
    .insert(workspaces)
    .values({ slug, name: slug, ...extra })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}

function bound(
  workspaceId: string,
  scopes: Principal["scopes"] = ["read", "write", "send", "spend"],
) {
  return engine.principal({ type: "agent", id: "key_bound", name: "Bound", workspaceId, scopes });
}

async function expectError(promise: Promise<unknown>, code: string): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OpenOutboundError);
  expect((error as OpenOutboundError).code).toBe(code);
  return error as OpenOutboundError;
}

beforeAll(async () => {
  engine = await createTestEngine({ modules: [demo] });
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  await engine.db.delete(workspaces);
  await engine.db.delete(idempotency_records);
  for (const key of Object.keys(calls)) delete calls[key];
  alpha = await insertWorkspace("alpha");
  beta = await insertWorkspace("beta");
});

describe("executor: principal, operation, scopes", () => {
  it("rejects unknown operations with a hint", async () => {
    const error = await expectError(
      engine.call("demo.nope", {}, { workspace: "alpha" }),
      "not_found",
    );
    expect(error.hint).toContain("demo.read");
  });

  it("rejects calls without a principal", async () => {
    await expectError(engine.runtime.call("demo.read", {}, {} as never), "unauthorized");
  });

  it("checks scopes from the effect and names the missing scope", async () => {
    const error = await expectError(
      engine.call("demo.write", { name: "x" }, { workspace: "alpha", scopes: ["read"] }),
      "forbidden",
    );
    expect(error.details).toMatchObject({ missing_scope: "write" });
    await expect(
      engine.call("demo.read", {}, { workspace: "alpha", scopes: ["read"] }),
    ).resolves.toMatchObject({
      workspace: "alpha",
    });
  });
});

describe("executor: workspace resolution and isolation", () => {
  it("uses explicit workspace by slug or id, and CallOptions win over input", async () => {
    await expect(engine.call("demo.read", { workspace: "beta" })).resolves.toMatchObject({
      workspace: "beta",
    });
    await expect(engine.call("demo.read", { workspace: beta.id })).resolves.toMatchObject({
      workspace: "beta",
    });
    await expect(
      engine.call("demo.read", { workspace: "beta" }, { workspace: "alpha" }),
    ).resolves.toMatchObject({
      workspace: "alpha",
    });
  });

  it("never lets a bound principal reach another workspace, existing or not", async () => {
    const principal = bound(alpha.id);
    await expect(engine.call("demo.read", {}, { principal })).resolves.toMatchObject({
      workspace: "alpha",
    });
    const existing = await expectError(
      engine.call("demo.read", {}, { principal, workspace: "beta" }),
      "forbidden",
    );
    const missing = await expectError(
      engine.call("demo.read", {}, { principal, workspace: "ghost" }),
      "forbidden",
    );
    expect(existing.message).toBe(missing.message);
  });

  it("falls back to the only real workspace, else lists slugs", async () => {
    const error = await expectError(engine.call("demo.read", {}), "validation_failed");
    expect(error.hint).toContain("Pass workspace: 'alpha'");
    expect(error.details).toMatchObject({ workspaces: ["alpha", "beta"] });

    await engine.db
      .update(workspaces)
      .set({ status: "archived" })
      .where(eq(workspaces.id, beta.id));
    await insertWorkspace("practice", { is_sandbox: true });
    await expect(engine.call("demo.read", {})).resolves.toMatchObject({ workspace: "alpha" });
  });

  it("falls back to the only sandbox when there is no real workspace", async () => {
    await engine.db.delete(workspaces);
    await expectError(engine.call("demo.read", {}), "validation_failed");
    await insertWorkspace("practice", { is_sandbox: true });
    await expect(engine.call("demo.read", {})).resolves.toMatchObject({ workspace: "practice" });
    await insertWorkspace("practice-2", { is_sandbox: true });
    await expectError(engine.call("demo.read", {}), "validation_failed");
  });

  it("leaves optional workspaces empty and reports unknown slugs", async () => {
    await expect(engine.call("demo.optional", {})).resolves.toEqual({ workspace: null });
    await expectError(engine.call("demo.optional", { workspace: "ghost" }), "not_found");
  });
});

describe("executor: sessions bound to a workspace", () => {
  it("binds an unbound principal to the session's workspace and fences the others", async () => {
    await expect(
      engine.call("demo.read", {}, { boundWorkspace: "alpha", scopes: ["read"] }),
    ).resolves.toMatchObject({ workspace: "alpha" });
    await expect(
      engine.call("demo.read", {}, { boundWorkspace: alpha.id, scopes: ["read"] }),
    ).resolves.toMatchObject({ workspace: "alpha" });
    const other = await expectError(
      engine.call("demo.read", { workspace: "beta" }, { boundWorkspace: "alpha" }),
      "forbidden",
    );
    expect(other.details).toMatchObject({ reason: "workspace_scope" });
    // The refusal names the bound workspace (never whether the other one exists).
    expect(other.message).toBe(
      'This key or session is bound to workspace "alpha" and cannot access another workspace.',
    );
    expect(other.hint).toContain("Omit `workspace` to work in alpha");
    const ghostWorkspace = await expectError(
      engine.call("demo.read", { workspace: "ghost" }, { boundWorkspace: "alpha" }),
      "forbidden",
    );
    expect(ghostWorkspace.message).toBe(other.message);
    const instance = await expectError(
      engine.call("demo.instance_write", {}, { boundWorkspace: "alpha" }),
      "forbidden",
    );
    expect(instance.details).toMatchObject({ reason: "instance_only" });
    await expect(
      engine.call("demo.instance_read", {}, { boundWorkspace: "alpha" }),
    ).resolves.toEqual({ bound_to: alpha.id });
  });

  it("never widens a principal bound elsewhere and names a workspace that does not exist", async () => {
    await expect(
      engine.call("demo.read", {}, { principal: bound(alpha.id), boundWorkspace: "alpha" }),
    ).resolves.toMatchObject({ workspace: "alpha" });
    const widened = await expectError(
      engine.call("demo.read", {}, { principal: bound(alpha.id), boundWorkspace: "beta" }),
      "forbidden",
    );
    const ghostForBound = await expectError(
      engine.call("demo.read", {}, { principal: bound(alpha.id), boundWorkspace: "ghost" }),
      "forbidden",
    );
    expect(ghostForBound.message).toBe(widened.message);
    const ghost = await expectError(
      engine.call("demo.read", {}, { boundWorkspace: "ghost" }),
      "not_found",
    );
    expect(ghost.hint).toContain("--workspace");
  });
});

describe("executor: operations without a workspace", () => {
  it("refuses instance-level operations to bound principals, before the scope check", async () => {
    const error = await expectError(
      engine.call("demo.instance_write", {}, { principal: bound(alpha.id, ["read"]) }),
      "forbidden",
    );
    expect(error.details).toMatchObject({ reason: "instance_only" });
    expect(error.hint).toContain("instance-level");
    expect(calls["demo.instance_write"]).toBeUndefined();
    await expect(engine.call("demo.instance_write", {})).resolves.toEqual({ ok: true });
  });

  it("lets bound principals call operations marked allow", async () => {
    await expect(
      engine.call("demo.instance_read", {}, { principal: bound(alpha.id) }),
    ).resolves.toEqual({ bound_to: alpha.id });
    // Naming a workspace changes nothing: these operations do not resolve one.
    await expect(
      engine.call("demo.instance_read", { workspace: "beta" }, { principal: bound(alpha.id) }),
    ).resolves.toEqual({ bound_to: alpha.id });
  });

  it("rejects definitions without a policy, or with one they cannot use", () => {
    const base = {
      id: "demo.no_policy",
      summary: "No policy",
      description: "Forgot the policy.",
      effect: "write" as const,
      input: z.object({}),
      output: z.object({}),
      dryRun: "none" as const,
      idempotent: true,
      examples: [],
      handler: async () => ({}),
    };
    expect(() => defineOperation({ ...base, workspace: "none" } as never)).toThrow(
      /boundPrincipals/,
    );
    expect(() =>
      defineOperation({ ...base, workspace: "required", boundPrincipals: "allow" } as never),
    ).toThrow(/only for workspace "none"/);
  });
});

describe("executor: input, dry run, output", () => {
  it("strips common fields before validating strict inputs and records the reason", async () => {
    const result = await engine.call("demo.write", {
      name: "Harbor",
      workspace: "alpha",
      reason: "Testing the gate",
      response_format: "detailed",
    });
    expect(result).toEqual({ name: "Harbor", calls: 1, reason: "Testing the gate" });
  });

  it("returns validation_failed with issues and an example", async () => {
    const error = await expectError(
      engine.call("demo.write", { name: 3, workspace: "alpha" }),
      "validation_failed",
    );
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path: "name" })] });
    expect(error.hint).toContain('"name":"Harbor"');
    await expectError(
      engine.call("demo.write", "nope", { workspace: "alpha" }),
      "validation_failed",
    );
  });

  it("runs dry runs without side effects and audits them", async () => {
    const preview = await engine.call("demo.write", {
      name: "Harbor",
      dry_run: true,
      workspace: "alpha",
    });
    expect(preview).toEqual({ dry_run: true, preview: { name: "Harbor" }, warnings: [] });
    expect(calls["demo.write"]).toBeUndefined();
    const [row] = await engine.db
      .select()
      .from(audit_events)
      .where(and(eq(audit_events.operation, "demo.write"), eq(audit_events.status, "dry_run")));
    expect(row).toBeDefined();
  });

  it("previews by default for dryRun default ops until dry_run is false", async () => {
    await expect(engine.call("demo.send", {}, { workspace: "alpha" })).resolves.toMatchObject({
      dry_run: true,
    });
    await expect(
      engine.call("demo.send", { dry_run: false }, { workspace: "alpha" }),
    ).resolves.toEqual({ sent: true });
  });

  it("refuses dry_run on ops without a preview and ignores it on reads", async () => {
    await expectError(
      engine.call("demo.fail", { dry_run: true }, { workspace: "alpha" }),
      "unsupported",
    );
    await expect(
      engine.call("demo.read", { dry_run: true }, { workspace: "alpha" }),
    ).resolves.toMatchObject({
      dry: false,
    });
  });

  it("passes response_format through and turns bad outputs into internal errors", async () => {
    await expect(
      engine.call("demo.read", {}, { workspace: "alpha", responseFormat: "detailed" }),
    ).resolves.toMatchObject({ format: "detailed" });
    await expectError(engine.call("demo.bad_output", {}), "internal");
  });
});

describe("executor: idempotency", () => {
  it("replays the same request and rejects a different one", async () => {
    const first = await engine.call(
      "demo.write",
      { name: "A", idempotency_key: "k1" },
      { workspace: "alpha" },
    );
    const again = await engine.call(
      "demo.write",
      { name: "A" },
      { workspace: "alpha", idempotencyKey: "k1" },
    );
    expect(again).toEqual(first);
    expect(calls["demo.write"]).toBe(1);
    const error = await expectError(
      engine.call("demo.write", { name: "B", idempotency_key: "k1" }, { workspace: "alpha" }),
      "idempotency_mismatch",
    );
    expect(error.hint).toContain("idempotency_key");
  });

  it("scopes keys per workspace and frees them after failures", async () => {
    await engine.call("demo.write", { name: "A", idempotency_key: "k2" }, { workspace: "alpha" });
    await engine.call("demo.write", { name: "A", idempotency_key: "k2" }, { workspace: "beta" });
    expect(calls["demo.write"]).toBe(2);
    await expectError(
      engine.call("demo.fail", { idempotency_key: "k3" }, { workspace: "alpha" }),
      "conflict",
    );
    await expectError(
      engine.call("demo.fail", { idempotency_key: "k3" }, { workspace: "alpha" }),
      "conflict",
    );
    expect(calls["demo.fail"]).toBe(2);
  });

  it("expires records after 24 hours", async () => {
    await engine.call("demo.write", { name: "A", idempotency_key: "k4" }, { workspace: "alpha" });
    engine.advance(24 * 60 * 60 * 1000 + 1);
    await engine.call("demo.write", { name: "B", idempotency_key: "k4" }, { workspace: "alpha" });
    expect(calls["demo.write"]).toBe(2);
  });
});

describe("executor: paused workspaces, budgets, audit", () => {
  it("blocks send ops (not writes) in paused workspaces", async () => {
    await engine.db.update(workspaces).set({ status: "paused" }).where(eq(workspaces.id, alpha.id));
    const error = await expectError(
      engine.call("demo.send", { dry_run: false }, { workspace: "alpha" }),
      "workspace_paused",
    );
    expect(error.status).toBe(423);
    expect(error.hint).toContain("resume");
    await expect(
      engine.call("demo.write", { name: "ok" }, { workspace: "alpha" }),
    ).resolves.toMatchObject({
      name: "ok",
    });
  });

  it("blocks spend ops over the monthly data budget", async () => {
    await engine.db
      .update(workspaces)
      .set({ settings: { data: { monthly_credit_budget: 10 } } })
      .where(eq(workspaces.id, alpha.id));
    await expect(engine.call("demo.spend", {}, { workspace: "alpha" })).resolves.toEqual({
      spent: true,
    });
    await engine.db.insert(usage_records).values({
      workspace_id: alpha.id,
      slot: "lead_source",
      provider: "apollo",
      operation: "leads.find",
      credits: 10,
      created_at: engine.clock.now(),
    });
    const error = await expectError(
      engine.call("demo.spend", {}, { workspace: "alpha" }),
      "budget_exceeded",
    );
    expect(error.hint).toContain("settings.data.monthly_credit_budget");
    await expect(engine.call("demo.spend", {}, { workspace: "beta" })).resolves.toEqual({
      spent: true,
    });
  });

  describe("dry runs of spend ops", () => {
    const USED_UP =
      "The monthly data budget is used up (10 of 10 credits), so the real run will be refused (budget_exceeded). Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).";

    async function budget(workspace: Workspace, monthly: number | null, used: number) {
      await engine.db
        .update(workspaces)
        .set({ settings: { data: { monthly_credit_budget: monthly } } })
        .where(eq(workspaces.id, workspace.id));
      if (used === 0) return;
      await engine.db.insert(usage_records).values({
        workspace_id: workspace.id,
        slot: "lead_source",
        provider: "apollo",
        operation: "leads.find",
        credits: used,
        created_at: engine.clock.now(),
      });
    }

    type Preview = { dry_run: true; preview: { credits: number }; warnings: string[] };
    const preview = (input: Record<string, unknown>, workspace = "alpha") =>
      engine.call(
        "demo.spend_preview",
        { ...input, dry_run: true },
        { workspace },
      ) as Promise<Preview>;

    it("still preview when the data budget is used up, warning that the real run is refused", async () => {
      await budget(alpha, 10, 10);
      const result = await preview({ credits: 0 });
      expect(result).toMatchObject({ dry_run: true, preview: { credits: 0 } });
      expect(result.warnings).toEqual([USED_UP, "Checked the inputs."]);

      const refused = await expectError(
        engine.call("demo.spend_preview", { credits: 0 }, { workspace: "alpha" }),
        "budget_exceeded",
      );
      expect(refused.hint).toContain("settings.data.monthly_credit_budget");
      const rows = await engine.db
        .select()
        .from(audit_events)
        .where(
          and(
            eq(audit_events.operation, "demo.spend_preview"),
            eq(audit_events.workspace_id, alpha.id),
          ),
        )
        .orderBy(audit_events.id);
      expect(rows.map((row) => [row.status, row.error_code])).toEqual([
        ["dry_run", null],
        ["error", "budget_exceeded"],
      ]);
    });

    it("say it once when the operation's own warning already covers the used-up budget", async () => {
      await budget(alpha, 10, 12);
      const result = await preview({ credits: 3 });
      expect(result.warnings).toEqual([
        "Checked the inputs.",
        "The monthly data budget is used up (12 of 10 credits), so the real run will be refused (budget_exceeded). Wait until next month, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
      ]);
    });

    it("add nothing while the budget has room, or without a budget", async () => {
      await budget(alpha, 10, 4);
      expect((await preview({ credits: 0 })).warnings).toEqual(["Checked the inputs."]);
      expect((await preview({ credits: 8 })).warnings).toEqual([
        "Checked the inputs.",
        "Not enough data budget: needs 8 credits, 6 left this month (4 of 10 used), so the real run will be refused. Lower the count, or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
      ]);
      await budget(beta, null, 50);
      expect((await preview({ credits: 5 }, "beta")).warnings).toEqual(["Checked the inputs."]);
    });
  });

  it("audits non-read calls with outcome, reason, redacted input and failures", async () => {
    await engine.db.delete(audit_events);
    await engine.call("demo.read", {}, { workspace: "alpha" });
    await engine.call(
      "demo.write",
      { name: "A", api_key: "sk-secret-value" },
      { workspace: "alpha", reason: "why" },
    );
    await expectError(engine.call("demo.fail", {}, { workspace: "alpha" }), "conflict");
    await expectError(
      engine.call("demo.write", { name: "x" }, { workspace: "alpha", scopes: ["read"] }),
      "forbidden",
    );
    await engine.call("demo.gate", {}, { workspace: "alpha" });
    const rows = await engine.db.select().from(audit_events).orderBy(audit_events.id);
    expect(rows.map((row) => [row.operation, row.status, row.error_code])).toEqual([
      ["demo.write", "ok", null],
      ["demo.fail", "error", "conflict"],
      ["demo.write", "error", "forbidden"],
      ["demo.gate", "awaiting_approval", null],
    ]);
    expect(rows[0]?.reason).toBe("why");
    expect(rows[0]?.input).toEqual({ name: "A", api_key: "[redacted]" });
    expect(rows[0]?.workspace_id).toBe(alpha.id);
    expect(rows[3]?.target_type).toBe("approval");
  });

  it("records what an operation's auditInput returns, also for rejected input", async () => {
    await engine.db.delete(audit_events);
    await engine.call(
      "demo.erase",
      { email: "dana@harbor.example.com", person_id: "pe_1" },
      { workspace: "alpha" },
    );
    await expectError(
      engine.call("demo.erase", { email: "dana at harbor" }, { workspace: "alpha" }),
      "validation_failed",
    );
    const rows = await engine.db.select().from(audit_events).orderBy(audit_events.id);
    expect(rows.map((row) => [row.status, row.input])).toEqual([
      ["ok", { email: "[erased]", person_id: "pe_1" }],
      ["error", { email: "[erased]" }],
    ]);
    expect(rows[0]?.target_type).toBe("person");
    expect(JSON.stringify(rows)).not.toContain("dana");
  });
});
