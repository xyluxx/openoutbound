/** Monitor operations: scheduled signal collection over a set of companies. */
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  budgetHint,
  budgetWarning,
  dataBudgetShape,
  dataBudgetView,
} from "../../../core/budget.js";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { notFound } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import {
  defineOperation,
  dryRun,
  dryRunOutput,
  jobHandleOutput,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import {
  type Monitor,
  type MonitorBudget,
  type MonitorTarget,
  monitors,
} from "../../../db/schema/index.js";
import { BUILTIN_COLLECTORS, isBuiltinCollector, loadDefinitions } from "../catalog.js";
import { DEFAULT_MONITOR_COLLECTORS } from "../monitors/runner.js";
import { assertMonitorSchedule, nextMonitorRun, runsPerMonth } from "../monitors/schedule.js";
import {
  assertTargetExists,
  DEFAULT_MAX_COMPANIES,
  HARD_MAX_COMPANIES,
  resolveTargets,
} from "../monitors/targets.js";
import { monitorOutput, monitorView, signalKeySchema } from "../shapes.js";

export const MONITOR_RUN_JOB = "monitors.run";

const collectorName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,40}$/)
  .describe(`Built-in collector (${BUILTIN_COLLECTORS.join(", ")}) or a signal provider id`);

const fit = z.number().int().min(0).max(100);

const targetInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), list_id: idSchema("ls") }),
  z.object({
    kind: z.literal("companies"),
    company_ids: z.array(idSchema("co")).min(1).max(HARD_MAX_COMPANIES),
  }),
  z.object({
    kind: z.literal("icp"),
    icp_id: idSchema("icp").optional().describe("Also use this ICP's signal keys"),
    min_fit: fit.optional().describe("Minimum company fit_score (default 50)"),
  }),
  z.object({
    kind: z.literal("all_active"),
    min_fit: fit.optional().describe("Minimum company fit_score (default none)"),
  }),
]);

const budgetInput = z.object({
  max_companies: z
    .number()
    .int()
    .min(1)
    .max(HARD_MAX_COMPANIES)
    .optional()
    .describe(`Companies checked per run, best fit first (default ${DEFAULT_MAX_COMPANIES})`),
  max_credits_per_run: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe("Paid provider credits per run (no cap by default)"),
  max_credits_per_month: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional()
    .describe("Paid provider credits per calendar month for this monitor"),
});

const scheduleInput = z
  .string()
  .trim()
  .min(9)
  .max(100)
  .describe('Cron in the workspace timezone, at most hourly, e.g. "0 6 * * *" (daily 06:00)');

const estimateOutput = z.object({
  runs_per_month: z.number(),
  companies_per_run: z.number(),
  paid_providers: z.array(z.string()),
  credits_per_run: z.number(),
  credits_per_month: z.number(),
  note: z.string(),
});

const monitorWithEstimate = monitorOutput.extend({
  estimate: estimateOutput,
  warnings: z.array(z.string()),
});

interface ProviderCost {
  id: string;
  configured: boolean;
  credits: number;
}

async function providerCosts(
  ctx: OpContext,
  collectors: readonly string[],
): Promise<ProviderCost[]> {
  const out: ProviderCost[] = [];
  for (const id of new Set(collectors)) {
    if (isBuiltinCollector(id)) continue;
    const provider = await ctx.providers.tryGet("signals", { id });
    out.push({ id, configured: Boolean(provider), credits: provider?.creditsPerCall ?? 1 });
  }
  return out;
}

async function estimate(
  ctx: OpContext,
  monitor: Pick<Monitor, "workspace_id" | "schedule" | "collectors" | "budget" | "signal_keys">,
) {
  const timezone = ctx.workspace?.timezone ?? "UTC";
  const runs = runsPerMonth(monitor.schedule, timezone, ctx.clock.now());
  const companies = monitor.budget.max_companies ?? DEFAULT_MAX_COMPANIES;
  const costs = await providerCosts(ctx, monitor.collectors);
  let perRun = companies * costs.reduce((sum, cost) => sum + cost.credits, 0);
  if (monitor.budget.max_credits_per_run !== undefined) {
    perRun = Math.min(perRun, monitor.budget.max_credits_per_run);
  }
  let perMonth = perRun * runs;
  if (monitor.budget.max_credits_per_month !== undefined) {
    perMonth = Math.min(perMonth, monitor.budget.max_credits_per_month);
  }
  return {
    estimate: {
      runs_per_month: runs,
      companies_per_run: companies,
      paid_providers: costs.map((cost) => cost.id),
      credits_per_run: perRun,
      credits_per_month: perMonth,
      note: "Upper bound: every targeted company checked every run. Free collectors cost no credits; AI calls only run when pages or feeds changed.",
    },
    warnings: [
      ...costs
        .filter((cost) => !cost.configured)
        .map(
          (cost) =>
            `Provider "${cost.id}" is not configured; runs skip it until you set it up with manage_providers.`,
        ),
      ...(await keyWarnings(ctx, monitor.workspace_id, monitor.signal_keys)),
    ],
  };
}

async function keyWarnings(
  ctx: OpContext,
  workspaceId: string,
  keys: readonly string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const definitions = await loadDefinitions(ctx.db, workspaceId);
  return keys.flatMap((key) => {
    const definition = definitions.get(key);
    if (!definition) return [`Signal key "${key}" does not exist; the monitor ignores it.`];
    if (!definition.enabled) return [`Signal "${key}" is disabled, so the monitor skips it.`];
    return [];
  });
}

function cleanTarget(target: z.output<typeof targetInput>): MonitorTarget {
  switch (target.kind) {
    case "list":
      return { kind: "list", list_id: target.list_id };
    case "companies":
      return { kind: "companies", company_ids: [...new Set(target.company_ids)] };
    case "icp":
      return {
        kind: "icp",
        ...(target.icp_id ? { icp_id: target.icp_id } : {}),
        ...(target.min_fit !== undefined ? { min_fit: target.min_fit } : {}),
      };
    case "all_active":
      return {
        kind: "all_active",
        ...(target.min_fit !== undefined ? { min_fit: target.min_fit } : {}),
      };
  }
}

function cleanBudget(
  budget: z.output<typeof budgetInput>,
  base: MonitorBudget = {},
): MonitorBudget {
  const out: MonitorBudget = { ...base };
  if (budget.max_companies !== undefined) out.max_companies = budget.max_companies;
  if (budget.max_credits_per_run !== undefined)
    out.max_credits_per_run = budget.max_credits_per_run;
  if (budget.max_credits_per_month !== undefined) {
    out.max_credits_per_month = budget.max_credits_per_month;
  }
  return out;
}

async function requireMonitor(ctx: OpContext, workspaceId: string, monitorId: string) {
  const [row] = await ctx.db
    .select()
    .from(monitors)
    .where(and(eq(monitors.workspace_id, workspaceId), eq(monitors.id, monitorId)));
  if (!row) throw notFound("Monitor", monitorId);
  return row;
}

export const monitorsList = defineOperation({
  id: "signals.monitors.list",
  summary: "List signal monitors and their last results",
  description:
    "Lists the workspace's monitors (which companies are watched, with which collectors, how often and within which budget) with the last run's summary: status (ok, partial or failed), companies checked, new signals by key, credits used, provider failures and why a run stopped early. Use it to check that signal collection is running and what it costs; a run with failures keeps last_run_at, so the next run looks at the same window again. To see the signals themselves use signals.feed. Notes in last_result may quote outside pages.",
  effect: "read",
  input: paginationInput.extend({
    enabled: z.boolean().optional().describe("Only enabled (true) or paused (false) monitors"),
  }),
  output: paginated(monitorOutput),
  http: { method: "GET", path: "/v1/monitors" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Every monitor", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [eq(monitors.workspace_id, workspace.id)];
    if (input.enabled !== undefined) conditions.push(eq(monitors.enabled, input.enabled));
    if (input.cursor) {
      conditions.push(lt(monitors.id, String(decodeCursor<{ id: string }>(input.cursor).id)));
    }
    const rows = await ctx.db
      .select()
      .from(monitors)
      .where(and(...conditions))
      .orderBy(desc(monitors.id))
      .limit(input.limit + 1);
    return toPage(
      rows,
      input.limit,
      (row) => ({ id: row.id }),
      (row) => monitorView(row, ctx.request.responseFormat),
    );
  },
});

export const monitorsCreate = defineOperation({
  id: "signals.monitors.create",
  summary: "Watch a set of companies for signals on a schedule",
  description:
    "Creates a monitor: on a cron schedule it checks the target companies (a list, explicit ids, ICP fit or all active companies) with free collectors (website_changes, job_boards, news_gdelt, rss, tech_detect) and any paid signal providers you name, evaluates custom signals and records what it finds. Use it once per segment you want watched; the answer includes a monthly credit estimate. To look for signals right now use signals.monitors.run after creating it, and to add signals you found yourself use signals.ingest. Monitors run at most hourly and check at most max_companies companies per run, best fit first.",
  effect: "write",
  input: z.object({
    name: z.string().trim().min(1).max(120),
    target: targetInput,
    collectors: z
      .array(collectorName)
      .min(1)
      .max(12)
      .default([...DEFAULT_MONITOR_COLLECTORS])
      .describe("Collectors and provider ids to run (default: every free web collector)"),
    signal_keys: z
      .array(signalKeySchema)
      .max(50)
      .default([])
      .describe("Only look for these signals (default: every enabled signal)"),
    schedule: scheduleInput.default("0 6 * * *"),
    enabled: z.boolean().default(true),
    budget: budgetInput.default({}),
  }),
  output: monitorWithEstimate,
  http: { method: "POST", path: "/v1/monitors" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Daily watch of top-fit accounts",
      input: {
        name: "Tier A accounts",
        target: { kind: "icp", min_fit: 70 },
        schedule: "0 6 * * *",
        budget: { max_companies: 100 },
      },
    },
    {
      title: "Weekly paid check of one list",
      input: {
        name: "Target list with PredictLeads",
        target: { kind: "list", list_id: "ls_01k6a3v0q8x3m2n4p5r6s7t8v9" },
        collectors: ["job_boards", "predictleads"],
        schedule: "0 7 * * 1",
        budget: { max_companies: 50, max_credits_per_month: 1000 },
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const now = ctx.clock.now();
    assertMonitorSchedule(input.schedule, workspace.timezone, now);
    const target = cleanTarget(input.target);
    await assertTargetExists(ctx, workspace.id, target);
    const budget = cleanBudget(input.budget, { max_companies: DEFAULT_MAX_COMPANIES });
    const collectors = [...new Set(input.collectors)];
    const [row] = await ctx.db
      .insert(monitors)
      .values({
        workspace_id: workspace.id,
        name: input.name,
        target,
        collectors,
        signal_keys: [...new Set(input.signal_keys)],
        schedule: input.schedule,
        enabled: input.enabled,
        budget,
        next_run_at: input.enabled ? nextMonitorRun(input.schedule, workspace.timezone, now) : null,
      })
      .returning();
    if (!row) throw new Error("Monitor insert returned no row");
    return { ...monitorView(row, "detailed"), ...(await estimate(ctx, row)) };
  },
});

export const monitorsUpdate = defineOperation({
  id: "signals.monitors.update",
  summary: "Change or pause a monitor",
  description:
    "Changes a monitor's name, target, collectors, signal keys, schedule, budget or enabled flag; only the fields you pass change (budget fields merge). Use it to pause a monitor (enabled false), widen or narrow what it watches, or cap its spend. To run it now use signals.monitors.run. The answer repeats the monthly credit estimate for the new settings.",
  effect: "write",
  input: z.object({
    monitor_id: idSchema("mon"),
    name: z.string().trim().min(1).max(120).optional(),
    target: targetInput.optional(),
    collectors: z.array(collectorName).min(1).max(12).optional(),
    signal_keys: z.array(signalKeySchema).max(50).optional(),
    schedule: scheduleInput.optional(),
    enabled: z.boolean().optional(),
    budget: budgetInput.optional(),
  }),
  output: monitorWithEstimate,
  http: { method: "PATCH", path: "/v1/monitors/:monitor_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Pause a monitor",
      input: { monitor_id: "mon_01k6a3v0q8x3m2n4p5r6s7t8v9", enabled: false },
    },
    {
      title: "Cap monthly credits",
      input: {
        monitor_id: "mon_01k6a3v0q8x3m2n4p5r6s7t8v9",
        budget: { max_credits_per_month: 500 },
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const current = await requireMonitor(ctx, workspace.id, input.monitor_id);
    const now = ctx.clock.now();
    const set: Partial<typeof monitors.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.target) {
      const target = cleanTarget(input.target);
      await assertTargetExists(ctx, workspace.id, target);
      set.target = target;
    }
    if (input.collectors) set.collectors = [...new Set(input.collectors)];
    if (input.signal_keys) set.signal_keys = [...new Set(input.signal_keys)];
    if (input.schedule !== undefined) {
      assertMonitorSchedule(input.schedule, workspace.timezone, now);
      set.schedule = input.schedule;
    }
    if (input.enabled !== undefined) set.enabled = input.enabled;
    if (input.budget) set.budget = cleanBudget(input.budget, current.budget);
    const schedule = set.schedule ?? current.schedule;
    const enabled = set.enabled ?? current.enabled;
    if (input.schedule !== undefined || input.enabled !== undefined) {
      set.next_run_at = enabled ? nextMonitorRun(schedule, workspace.timezone, now) : null;
    }
    let row = current;
    if (Object.keys(set).length > 0) {
      const [updated] = await ctx.db
        .update(monitors)
        .set(set)
        .where(eq(monitors.id, current.id))
        .returning();
      if (updated) row = updated;
    }
    return { ...monitorView(row, "detailed"), ...(await estimate(ctx, row)) };
  },
});

const runPreview = z.object({
  monitor_id: z.string(),
  companies: z.number().describe("Companies this run would check"),
  companies_total: z.number().describe("Companies matching the target before max_companies"),
  collectors: z.array(z.string()),
  providers: z.array(z.object({ id: z.string(), configured: z.boolean(), credits: z.number() })),
  estimated_credits: z.number(),
  budget: dataBudgetShape,
});

export const monitorsRun = defineOperation({
  id: "signals.monitors.run",
  summary: "Run a monitor now",
  description:
    "Starts one run of a monitor in the background and returns a job handle (check it with get_job); new signals appear in signals.feed and trigger automation rules. Use it after creating a monitor or when you need fresh signals before a campaign; pass dry_run true first to see how many companies and credits the run would use and what is left of the data budget. For companies you only want researched, use research_lead instead. Paid providers spend credits within the monitor's budget and the workspace data budget: a paid call starts only when what is left covers it, and a call the provider refused or did not answer costs nothing.",
  effect: "spend",
  input: z.object({ monitor_id: idSchema("mon") }),
  output: z.union([jobHandleOutput, dryRunOutput(runPreview)]),
  http: { method: "POST", path: "/v1/monitors/:monitor_id/run" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Run a monitor", input: { monitor_id: "mon_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const monitor = await requireMonitor(ctx, workspace.id, input.monitor_id);
    if (ctx.request.dryRun) {
      const targets = await resolveTargets(
        ctx,
        workspace.id,
        monitor.target,
        monitor.budget.max_companies ?? DEFAULT_MAX_COMPANIES,
      );
      const costs = await providerCosts(ctx, monitor.collectors);
      let credits =
        targets.companies.length *
        costs.filter((cost) => cost.configured).reduce((sum, cost) => sum + cost.credits, 0);
      if (monitor.budget.max_credits_per_run !== undefined) {
        credits = Math.min(credits, monitor.budget.max_credits_per_run);
      }
      const warnings = costs
        .filter((cost) => !cost.configured)
        .map((cost) => `Provider "${cost.id}" is not configured and would be skipped.`);
      if (targets.companies.length === 0) warnings.push("The target matches no active companies.");
      const budget = await ctx.usage.budgetStatus(workspace.id, "data");
      const budgetNote = budgetWarning(budget, credits, {
        outcome:
          "paid provider calls stop at the first one that does not fit (the free collectors still run)",
        hint: budgetHint(
          budget,
          "Check fewer companies (budget.max_companies) or cap the run (budget.max_credits_per_run)",
        ),
      });
      if (budgetNote) warnings.push(budgetNote);
      return dryRun(
        {
          monitor_id: monitor.id,
          companies: targets.companies.length,
          companies_total: targets.total,
          collectors: monitor.collectors,
          providers: costs,
          estimated_credits: credits,
          budget: dataBudgetView(budget),
        },
        { warnings, estimatedCost: { credits, note: "Upper bound for paid providers." } },
      );
    }
    return ctx.jobs.enqueue(
      MONITOR_RUN_JOB,
      { workspace_id: workspace.id, monitor_id: monitor.id, trigger: "manual" },
      { workspaceId: workspace.id, singletonKey: `${MONITOR_RUN_JOB}:${monitor.id}` },
    );
  },
});

export const monitorsDelete = defineOperation({
  id: "signals.monitors.delete",
  summary: "Delete a monitor",
  description:
    "Deletes a monitor so it no longer runs; signals it already found stay. Use it for monitors you will not need again; to stop one for a while, pause it with signals.monitors.update (enabled false) and keep its history. A run already in progress finishes but saves nothing on the deleted monitor.",
  effect: "destructive",
  input: z.object({ monitor_id: idSchema("mon") }),
  output: z.object({ monitor_id: z.string(), deleted: z.boolean() }),
  http: { method: "DELETE", path: "/v1/monitors/:monitor_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Delete a monitor", input: { monitor_id: "mon_01k6a3v0q8x3m2n4p5r6s7t8v9" } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const deleted = await ctx.db
      .delete(monitors)
      .where(and(eq(monitors.workspace_id, workspace.id), eq(monitors.id, input.monitor_id)))
      .returning({ id: monitors.id });
    return { monitor_id: input.monitor_id, deleted: deleted.length > 0 };
  },
});

export const monitorOperations = [
  monitorsList,
  monitorsCreate,
  monitorsUpdate,
  monitorsRun,
  monitorsDelete,
];
