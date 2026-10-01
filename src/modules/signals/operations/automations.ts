/** Automation rule operations: what happens automatically when a signal is detected. */
import { and, desc, eq, inArray, lt, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import { stableStringify } from "../../../brain/hash.js";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { notFound, OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import {
  type AutomationAction,
  type AutomationRule,
  automation_firings,
  automation_rules,
  campaigns,
  lists,
  signals,
} from "../../../db/schema/index.js";
import { mustRequestApproval } from "../../../runtime/approval-rule.js";
import { previewAction } from "../automations/actions.js";
import {
  dropUnusedSecrets,
  enrollsUnattended,
  requestUnattendedApproval,
} from "../automations/approval.js";
import { loadSubject } from "../automations/engine.js";
import { evaluateRuleFilters } from "../automations/filters.js";
import {
  type AutomationActionInput,
  type AutomationFilters,
  automationActionInput,
  automationFiltersInput,
  MAX_ACTIONS_PER_RULE,
  readFilters,
  SIGNAL_DETECTED,
  type StoredAction,
} from "../automations/schema.js";
import { loadDefinitions } from "../catalog.js";
import { automationRuleOutput, automationRuleView } from "../shapes.js";

const ruleWithWarnings = automationRuleOutput.extend({ warnings: z.array(z.string()) });

const actionsInput = z
  .array(automationActionInput)
  .min(1)
  .max(MAX_ACTIONS_PER_RULE)
  .describe(
    "What to do: notify, add_to_list (list_id), research, webhook (url, secret?), enroll (campaign_id), tag (tag)",
  );

async function requireRule(ctx: OpContext, workspaceId: string, ruleId: string) {
  const [row] = await ctx.db
    .select()
    .from(automation_rules)
    .where(and(eq(automation_rules.workspace_id, workspaceId), eq(automation_rules.id, ruleId)));
  if (!row) throw notFound("Automation rule", ruleId);
  return row;
}

/** Checks referenced lists, campaigns and signal keys; returns warnings for soft problems. */
async function validateRule(
  ctx: OpContext,
  workspaceId: string,
  filters: AutomationFilters,
  actions: readonly AutomationActionInput[],
): Promise<string[]> {
  const warnings: string[] = [];
  const listIds = [
    ...new Set([
      ...(filters.list_id ? [filters.list_id] : []),
      ...actions.flatMap((action) => (action.type === "add_to_list" ? [action.list_id] : [])),
    ]),
  ];
  if (listIds.length > 0) {
    const rows = await ctx.db
      .select({ id: lists.id, kind: lists.kind })
      .from(lists)
      .where(and(eq(lists.workspace_id, workspaceId), inArray(lists.id, listIds)));
    for (const id of listIds) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw notFound("List", id);
      const isTarget = actions.some(
        (action) => action.type === "add_to_list" && action.list_id === id,
      );
      if (isTarget && row.kind !== "static") {
        throw new OpenOutboundError("validation_failed", `List ${id} is a smart list.`, {
          hint: "add_to_list needs a static list; create one with manage_lists.",
          details: { field: "actions" },
        });
      }
    }
  }
  const campaignIds = [
    ...new Set(actions.flatMap((action) => (action.type === "enroll" ? [action.campaign_id] : []))),
  ];
  if (campaignIds.length > 0) {
    const rows = await ctx.db
      .select({ id: campaigns.id, status: campaigns.status })
      .from(campaigns)
      .where(and(eq(campaigns.workspace_id, workspaceId), inArray(campaigns.id, campaignIds)));
    for (const id of campaignIds) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw notFound("Campaign", id);
      if (row.status !== "active") {
        warnings.push(`Campaign ${id} is ${row.status}; enrollments only start once it is active.`);
      }
    }
  }
  const keys = filters.definition_keys ?? [];
  if (keys.length > 0) {
    const definitions = await loadDefinitions(ctx.db, workspaceId);
    for (const key of keys) {
      const definition = definitions.get(key);
      if (!definition)
        warnings.push(`Signal key "${key}" does not exist (yet); the rule ignores it.`);
      else if (!definition.enabled)
        warnings.push(`Signal "${key}" is disabled, so it never fires.`);
    }
  }
  if (actions.some((action) => action.type === "webhook" && action.url.startsWith("http:"))) {
    warnings.push("The webhook URL uses plain http; prefer https.");
  }
  return warnings;
}

/**
 * Converts input actions to stored actions: webhook secrets go to the vault. A webhook action
 * without a new secret keeps the secret of the previous action with the same URL.
 */
async function storeActions(
  ctx: OpContext,
  workspaceId: string,
  ruleId: string,
  actions: readonly AutomationActionInput[],
  previous: readonly AutomationAction[] = [],
): Promise<StoredAction[]> {
  const stored: StoredAction[] = [];
  for (const [index, action] of actions.entries()) {
    if (action.type !== "webhook") {
      stored.push(action as StoredAction);
      continue;
    }
    let secretId: string | undefined;
    if (action.secret) {
      secretId = await ctx.vault.putSecret(
        workspaceId,
        `automation:${ruleId}:webhook:${index}`,
        action.secret,
      );
    } else {
      const old = previous.find((item) => item.type === "webhook" && item.url === action.url);
      if (typeof old?.secret_id === "string") secretId = old.secret_id;
    }
    stored.push({ type: "webhook", url: action.url, ...(secretId ? { secret_id: secretId } : {}) });
  }
  return stored;
}

function cleanFilters(filters: AutomationFilters): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
}

/** The enroll actions of a rule (campaign and people per signal), comparable as one string. */
function enrollPart(actions: ReadonlyArray<{ type: string }>): string {
  return stableStringify(actions.filter((action) => action.type === "enroll"));
}

export const automationsList = defineOperation({
  id: "signals.automations.list",
  summary: "List automation rules",
  description:
    "Lists the workspace's automation rules: which signals they react to (filters), what they do (actions) and when they last fired. Use it before creating a rule to avoid duplicates, or to audit what the engine does on its own. To see what a rule would do for real signals use signals.automations.test. Webhook secrets are never shown.",
  effect: "read",
  input: paginationInput.extend({
    enabled: z.boolean().optional().describe("Only enabled (true) or paused (false) rules"),
  }),
  output: paginated(automationRuleOutput),
  http: { method: "GET", path: "/v1/automations" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Every rule", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [eq(automation_rules.workspace_id, workspace.id)];
    if (input.enabled !== undefined) conditions.push(eq(automation_rules.enabled, input.enabled));
    if (input.cursor) {
      conditions.push(
        lt(automation_rules.id, String(decodeCursor<{ id: string }>(input.cursor).id)),
      );
    }
    const rows = await ctx.db
      .select()
      .from(automation_rules)
      .where(and(...conditions))
      .orderBy(desc(automation_rules.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }), automationRuleView);
  },
});

export const automationsCreate = defineOperation({
  id: "signals.automations.create",
  summary: "Create a rule that acts on new signals",
  description:
    "Creates an automation rule that runs when a new signal is detected and passes its filters (signal keys, min_score, ICP fit via min_fit, list, has_email). Actions: notify the team, add people to a list, request research, POST a signed webhook, tag the company or people, or enroll people in a campaign. Use it to turn signals into action without polling; test it first with signals.automations.test. Enroll actions ask a person for approval unless require_approval is false, which only a person holding the approve scope sets directly (anyone else gets the rule with approvals on and an approval of kind automation_approval); every rule fires at most once per signal and max_fires_per_day times a day.",
  effect: "write",
  input: z.object({
    name: z.string().trim().min(1).max(120),
    filters: automationFiltersInput.default({}),
    actions: actionsInput,
    require_approval: z
      .boolean()
      .optional()
      .describe("Enroll actions need approval first (default true when the rule enrolls)"),
    enabled: z.boolean().default(true),
  }),
  output: z.union([ruleWithWarnings, awaitingApprovalOutput]),
  http: { method: "POST", path: "/v1/automations" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Alert on strong funding signals at good-fit companies",
      input: {
        name: "Funding alert",
        filters: { definition_keys: ["funding_round"], min_score: 40, min_fit: 60 },
        actions: [{ type: "notify" }, { type: "research", max_people: 2 }],
      },
    },
    {
      title: "Enroll champions who changed jobs (with approval)",
      input: {
        name: "Champion moved",
        filters: { definition_keys: ["job_change"], has_email: true },
        actions: [{ type: "enroll", campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9", max_people: 1 }],
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const warnings = await validateRule(ctx, workspace.id, input.filters, input.actions);
    const requested =
      input.require_approval ?? input.actions.some((action) => action.type === "enroll");
    // Enrolling without asking is a gate (spec 2): someone who must ask gets approvals on.
    const held =
      enrollsUnattended({ require_approval: requested, actions: input.actions }) &&
      mustRequestApproval(ctx.principal);
    const requireApproval = held ? true : requested;
    const [row] = await ctx.db
      .insert(automation_rules)
      .values({
        workspace_id: workspace.id,
        name: input.name,
        enabled: input.enabled,
        trigger: { event: SIGNAL_DETECTED, filters: cleanFilters(input.filters) },
        actions: [],
        require_approval: requireApproval,
      })
      .returning();
    if (!row) throw new Error("Automation rule insert returned no row");
    const actions = await storeActions(ctx, workspace.id, row.id, input.actions);
    const [saved] = await ctx.db
      .update(automation_rules)
      .set({ actions: actions as AutomationAction[] })
      .where(eq(automation_rules.id, row.id))
      .returning();
    if (held) {
      const approvalId = await requestUnattendedApproval(ctx, saved ?? row);
      return awaitingApproval(
        approvalId,
        `Created rule ${row.id} ("${row.name}") with require_approval on: turning it off waits for a person with the approve scope (review_items). Until then each enrollment it makes waits for approval.`,
      );
    }
    return { ...automationRuleView(saved ?? row), warnings };
  },
});

export const automationsUpdate = defineOperation({
  id: "signals.automations.update",
  summary: "Change, pause or resume an automation rule",
  description:
    "Changes an automation rule: name, enabled, require_approval, or its filters or actions (each replaced as a whole when passed); a webhook action passed without a secret keeps the secret it had for the same URL. Use it to pause a noisy rule (enabled false) or tighten its filters, and try the change on real signals first with signals.automations.test. Letting a rule enroll people without approval (require_approval false on a rule with enroll actions), and changing the filters or enroll actions of a rule that already does, needs a person holding the approve scope: anyone else gets an approval of kind automation_approval (awaiting_approval) that shows the filters and actions, the rule keeps asking (or keeps its filters and actions) until a person approves, and the other changes apply at once. A request answers conflict when the rule changed after it was made.",
  effect: "write",
  input: z.object({
    rule_id: idSchema("rul"),
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    filters: automationFiltersInput.optional(),
    actions: actionsInput.optional(),
    require_approval: z.boolean().optional(),
  }),
  output: z.union([ruleWithWarnings, awaitingApprovalOutput]),
  http: { method: "PATCH", path: "/v1/automations/:rule_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Pause a rule", input: { rule_id: "rul_01k6a3v0q8x3m2n4p5r6s7t8v9", enabled: false } },
    {
      title: "Only fire on stronger signals",
      input: { rule_id: "rul_01k6a3v0q8x3m2n4p5r6s7t8v9", filters: { min_score: 60 } },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const current = await requireRule(ctx, workspace.id, input.rule_id);
    const filters = input.filters ?? readFilters(current.trigger.filters);
    const warnings =
      input.filters || input.actions
        ? await validateRule(ctx, workspace.id, filters, input.actions ?? [])
        : [];
    const set: Partial<typeof automation_rules.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.enabled !== undefined) set.enabled = input.enabled;
    const ask = mustRequestApproval(ctx.principal);
    const after = {
      require_approval: input.require_approval ?? current.require_approval,
      actions: input.actions ?? current.actions,
    };
    // Enrolling without asking is a gate (spec 2): when this update would start it, someone who
    // must ask gets approvals on (kept, or turned on) and an approval to turn them off.
    const held = !enrollsUnattended(current) && enrollsUnattended(after) && ask;
    // On a rule that already enrolls without asking, who it enrolls (its filters and enroll
    // actions) is the gate: the rule keeps both until a person approves the change.
    const nextFilters = input.filters ? cleanFilters(input.filters) : undefined;
    const retarget =
      ask &&
      enrollsUnattended(current) &&
      enrollsUnattended(after) &&
      ((nextFilters !== undefined &&
        stableStringify(nextFilters) !== stableStringify(current.trigger.filters ?? {})) ||
        (input.actions !== undefined && enrollPart(input.actions) !== enrollPart(current.actions)));
    if (retarget && input.actions?.some((action) => action.type === "webhook" && action.secret)) {
      throw new OpenOutboundError(
        "validation_failed",
        "A new webhook secret cannot wait in an approval request.",
        {
          hint: "Change the webhook in its own update (keeping the enroll actions and filters as they are), then ask for the new filters or enroll actions.",
          details: { field: "actions" },
        },
      );
    }
    if (held) set.require_approval = true;
    else if (input.require_approval !== undefined) set.require_approval = input.require_approval;
    let change: { filters: Record<string, unknown>; actions: StoredAction[] } | null = null;
    const actions = input.actions
      ? await storeActions(ctx, workspace.id, current.id, input.actions, current.actions)
      : null;
    if (retarget) {
      change = {
        filters: nextFilters ?? current.trigger.filters ?? {},
        actions: actions ?? (current.actions as StoredAction[]),
      };
    } else {
      if (nextFilters) set.trigger = { event: SIGNAL_DETECTED, filters: nextFilters };
      if (actions) {
        await dropUnusedSecrets(ctx, current.actions, actions);
        set.actions = actions as AutomationAction[];
      }
    }
    let row: AutomationRule = current;
    if (Object.keys(set).length > 0) {
      const [updated] = await ctx.db
        .update(automation_rules)
        .set(set)
        .where(eq(automation_rules.id, current.id))
        .returning();
      if (updated) row = updated;
    }
    if (held || change) {
      const approvalId = await requestUnattendedApproval(ctx, row, change ?? undefined);
      const changed = Object.keys(set).filter((key) => key !== "require_approval");
      const rest = changed.length > 0 ? ` Changed now: ${changed.join(", ")}.` : "";
      return awaitingApproval(
        approvalId,
        change
          ? `Changing the filters or enroll actions of rule ${row.id} ("${row.name}"), which enrolls people without approval, waits for a person with the approve scope (review_items); until then it keeps its filters and actions.${rest}`
          : `Turning off require_approval on rule ${row.id} ("${row.name}") waits for a person with the approve scope (review_items); until then each enrollment it makes waits for approval.${rest}`,
      );
    }
    return { ...automationRuleView(row), warnings };
  },
});

export const automationsDelete = defineOperation({
  id: "signals.automations.delete",
  summary: "Delete an automation rule",
  description:
    "Deletes an automation rule and its firing history; its webhook secrets are removed from the vault. Use it for rules you no longer want; to stop one temporarily use signals.automations.update with enabled false. Approvals it already requested stay pending until someone decides them.",
  effect: "destructive",
  input: z.object({ rule_id: idSchema("rul") }),
  output: z.object({ rule_id: z.string(), deleted: z.boolean() }),
  http: { method: "DELETE", path: "/v1/automations/:rule_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Delete a rule", input: { rule_id: "rul_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const deleted = await ctx.db
      .delete(automation_rules)
      .where(
        and(
          eq(automation_rules.workspace_id, workspace.id),
          eq(automation_rules.id, input.rule_id),
        ),
      )
      .returning();
    for (const row of deleted) await dropUnusedSecrets(ctx, row.actions, []);
    return { rule_id: input.rule_id, deleted: deleted.length > 0 };
  },
});

const testResult = z.object({
  signal_id: z.string(),
  definition_key: z.string(),
  title: z.string(),
  score: z.number(),
  company_id: z.string().nullable(),
  matched: z.boolean(),
  reason: z.string().nullable(),
  people: z.number().describe("People the actions would act on"),
  already_fired: z.boolean(),
  would: z.array(z.string()),
  untrusted: z.literal(true).describe("Titles come from outside sources"),
});

export const automationsTest = defineOperation({
  id: "signals.automations.test",
  summary: "Try a rule on real signals without running it",
  description:
    "Shows what an automation rule would do: for one signal (signal_id) or the latest active signals, whether the filters match, why not, how many people the actions would touch and what each action would do. Pass rule_id to test a saved rule, or filters and actions to try a draft (they override the saved ones). Use it before creating or widening a rule; nothing is sent, stored or enrolled. Signals a saved rule already fired for are flagged already_fired.",
  effect: "read",
  input: z.object({
    rule_id: idSchema("rul").optional(),
    filters: automationFiltersInput.optional(),
    actions: actionsInput.optional(),
    require_approval: z.boolean().optional(),
    signal_id: idSchema("sig").optional().describe("Test on this signal only"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("How many recent active signals to test (default 10)"),
  }),
  output: z.object({
    checked: z.number(),
    matched: z.number(),
    results: z.array(testResult),
  }),
  http: { method: "POST", path: "/v1/automations/test" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Test a saved rule", input: { rule_id: "rul_01k6a3v0q8x3m2n4p5r6s7t8v9" } },
    {
      title: "Try a draft rule",
      input: {
        filters: { definition_keys: ["hiring_relevant_roles"], min_score: 30 },
        actions: [{ type: "notify" }],
        limit: 20,
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const saved = input.rule_id ? await requireRule(ctx, workspace.id, input.rule_id) : null;
    if (!saved && !input.actions) {
      throw new OpenOutboundError("validation_failed", "Pass rule_id or actions to test.", {
        hint: 'Example: { "filters": { "min_score": 40 }, "actions": [{ "type": "notify" }] }.',
        details: { field: "rule_id" },
      });
    }
    const filters = input.filters ?? readFilters(saved?.trigger.filters);
    const actions: StoredAction[] = input.actions
      ? input.actions.map((action) =>
          action.type === "webhook"
            ? { type: "webhook", url: action.url, ...(action.secret ? { secret_id: "new" } : {}) }
            : (action as StoredAction),
        )
      : ((saved?.actions ?? []) as StoredAction[]);
    const requireApproval =
      input.require_approval ??
      saved?.require_approval ??
      actions.some((action) => action.type === "enroll");

    const conditions: SQL[] = [eq(signals.workspace_id, workspace.id)];
    if (input.signal_id) conditions.push(eq(signals.id, input.signal_id));
    else conditions.push(ne(signals.status, "dismissed"));
    const rows = await ctx.db
      .select({ id: signals.id })
      .from(signals)
      .where(and(...conditions))
      .orderBy(desc(signals.detected_at), desc(signals.id))
      .limit(input.signal_id ? 1 : input.limit);
    if (input.signal_id && rows.length === 0) throw notFound("Signal", input.signal_id);
    const fired = saved
      ? new Set(
          (
            await ctx.db
              .select({ signal_id: automation_firings.signal_id })
              .from(automation_firings)
              .where(
                and(
                  eq(automation_firings.rule_id, saved.id),
                  inArray(
                    automation_firings.signal_id,
                    rows.map((row) => row.id),
                  ),
                ),
              )
          ).map((row) => row.signal_id),
        )
      : new Set<string>();

    const results: Array<z.input<typeof testResult>> = [];
    for (const { id } of rows) {
      const subject = await loadSubject(ctx, workspace.id, id);
      if (!subject) continue;
      const check = await evaluateRuleFilters(ctx, filters, subject);
      results.push({
        signal_id: id,
        definition_key: subject.signal.definition_key,
        title: subject.signal.title,
        score: subject.signal.score,
        company_id: subject.signal.company_id,
        matched: check.ok,
        reason: check.ok ? null : (check.reason ?? null),
        people: check.people.length,
        already_fired: fired.has(id),
        would: check.ok
          ? actions.map((action) => previewAction(action, check.people, subject, requireApproval))
          : [],
        untrusted: true,
      });
    }
    return {
      checked: results.length,
      matched: results.filter((item) => item.matched).length,
      results,
    };
  },
});

export const automationOperations = [
  automationsList,
  automationsCreate,
  automationsUpdate,
  automationsDelete,
  automationsTest,
];
