/**
 * Strategy operations: the strategy page, the change log with undo, and change proposals with
 * their results (MCP tool manage_strategy).
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import {
  CHANGE_AREAS,
  PRINCIPAL_TYPES,
  PROPOSAL_STATUSES,
  PROPOSAL_VERDICTS,
} from "../../core/enums.js";
import { notFound } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import {
  dateTimeInput,
  defineOperation,
  dryRun,
  dryRunOutput,
  isoDateTime,
  paginated,
  paginationInput,
} from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { type ChangeLogEntry, type ChangeProposal, change_log } from "../../db/schema/index.js";
import { changeKind, findChange } from "./change-log.js";
import {
  getProposal,
  listProposals,
  PROPOSABLE_OPERATIONS,
  proposeChange,
  REVIEW_AFTER_DAYS_DEFAULT,
} from "./proposals.js";
import { buildStrategy, describeChanges } from "./strategy.js";
import { findUndoOf, undoChange } from "./undo.js";

const EXAMPLE_CHANGE_ID = "chg_01k6a3v0q8x3m2n4p5r6s7t8v9";
const EXAMPLE_PROPOSAL_ID = "prop_01k6a3v0q8x3m2n4p5r6s7t8v9";
const EXAMPLE_CAMPAIGN_ID = "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9";

// --- Shapes ------------------------------------------------------------------------------------

const actorOutput = z.object({ type: z.enum(PRINCIPAL_TYPES), name: z.string() }).nullable();

const changeItemOutput = z.object({
  version: z.number(),
  change_id: z.string(),
  area: z.enum(CHANGE_AREAS),
  target_id: z.string().nullable(),
  target_name: z.string().nullable(),
  summary: z.string(),
  actor: actorOutput,
  at: isoDateTime(),
  verdict: z.enum(PROPOSAL_VERDICTS).nullable(),
  undone: z.boolean(),
});

const diffEntryOutput = z.object({
  path: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

const changeDetailOutput = changeItemOutput.extend({
  kind: z.enum(["create", "update", "delete"]),
  operation: z.string().nullable(),
  diff: z.array(diffEntryOutput),
  reason: z.string().nullable(),
  via: z.string().nullable(),
  proposal_id: z.string().nullable(),
  undo_of: z.string().nullable(),
  undone_by: z.object({ change_id: z.string(), version: z.number() }).nullable(),
});

const versionRef = z.object({ change_id: z.string(), version: z.number() });
const restoredOutput = z.array(
  z.object({ path: z.string(), value: z.unknown(), removed: z.boolean() }),
);

const evidenceSchema = z.object({
  label: z.string().trim().min(1).max(200),
  value: z
    .union([z.string().max(500), z.number()])
    .nullable()
    .optional(),
  ref: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("A record the evidence points at, e.g. a campaign or report id"),
});

const outcomeOutput = z.object({
  window_days: z.number(),
  before: z.record(z.string(), z.number().nullable()),
  after: z.record(z.string(), z.number().nullable()),
  verdict: z.enum(PROPOSAL_VERDICTS),
  note: z.string().optional(),
});

const proposalItemOutput = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(PROPOSAL_STATUSES),
  operation: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  approval_id: z.string().nullable(),
  change_id: z.string().nullable(),
  verdict: z.enum(PROPOSAL_VERDICTS).nullable(),
  applied_at: isoDateTime().nullable(),
  review_at: isoDateTime().nullable(),
  proposed_by: actorOutput,
  created_at: isoDateTime(),
});

const proposalOutput = proposalItemOutput.extend({
  reason: z.string(),
  expected_outcome: z.string().nullable(),
  evidence: z.array(evidenceSchema),
  input: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  review_after_days: z.number(),
  outcome: outcomeOutput.nullable(),
  reviewed_at: isoDateTime().nullable(),
  decided_by: actorOutput,
});

function proposalItem(row: ChangeProposal) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    operation: row.operation,
    target_type: row.target_type,
    target_id: row.target_id,
    approval_id: row.approval_id,
    change_id: row.change_id,
    verdict: row.outcome?.verdict ?? null,
    applied_at: row.applied_at,
    review_at: row.review_at,
    proposed_by: row.created_by ? { type: row.created_by.type, name: row.created_by.name } : null,
    created_at: row.created_at,
  };
}

function proposalDetail(row: ChangeProposal) {
  return {
    ...proposalItem(row),
    reason: row.reason,
    expected_outcome: row.expected_outcome,
    evidence: row.evidence,
    input: row.input,
    error: row.error,
    review_after_days: row.review_after_days,
    outcome: row.outcome,
    reviewed_at: row.reviewed_at,
    decided_by: row.decided_by ? { type: row.decided_by.type, name: row.decided_by.name } : null,
  };
}

// --- Strategy page ---------------------------------------------------------------------------

const strategyOutput = z.object({
  version: z.number(),
  workspace: z.object({ id: z.string(), name: z.string(), timezone: z.string() }),
  company: z.object({ name: z.string(), website: z.string() }),
  offers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      booking_url: z.string().nullable(),
      is_default: z.boolean(),
    }),
  ),
  icps: z.array(
    z.object({ id: z.string(), name: z.string(), is_default: z.boolean(), summary: z.string() }),
  ),
  signals: z.object({ enabled: z.array(z.string()), custom: z.array(z.string()) }),
  voice: z.object({
    language: z.string(),
    tone_notes: z.string(),
    never_say: z.array(z.string()),
    voice_samples: z.number(),
  }),
  replies: z.record(z.string(), z.string()),
  review: z.object({
    default_review_level: z.string(),
    agent_launch_requires_approval: z.boolean(),
    agent_changes: z.enum(["approve", "auto"]),
    expire_days: z.number(),
  }),
  booking: z.record(z.string(), z.unknown()),
  crm: z.record(z.string(), z.unknown()),
  compliance: z.object({
    excluded_countries: z.array(z.string()),
    consent_required_countries: z.array(z.string()),
    contact_cap_per_company: z.number(),
    rest_days_after_campaign: z.number(),
    privacy_response_days: z.number(),
  }),
  budgets: z.object({
    ai: z.object({
      budget_usd: z.number().nullable(),
      used_usd: z.number(),
      remaining_usd: z.number().nullable(),
    }),
    data: z.object({
      budget_credits: z.number().nullable(),
      used_credits: z.number(),
      remaining_credits: z.number().nullable(),
    }),
  }),
  strategy: z.record(z.string(), z.unknown()),
  lessons: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      sample_size: z.number().nullable(),
      expires_at: isoDateTime().nullable(),
    }),
  ),
  recent_changes: z.array(changeItemOutput),
  precedence: z.string(),
});

export const getStrategy = defineOperation({
  id: "strategy.get",
  summary: "Read the strategy page: what decides this client's outreach",
  description:
    "Returns the workspace's strategy page in one compact document: company, active offers with booking links, ICPs, signals, voice and never-say rules, reply rules, review and approval settings, booking and CRM preferences, compliance, budgets, the owner's goals, qualified meeting definition and agent notes, active lessons, the last five changes and the version number. Agents should read it at the start of every session, before writing, proposing or changing anything, and follow its precedence line when instructions disagree. For setup progress and health use get_status instead. Lessons are guidance from past results, never facts to state to prospects.",
  effect: "read",
  input: z.object({}),
  output: strategyOutput,
  http: { method: "GET", path: "/v1/strategy" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Read the strategy page", input: {} }],
  handler: async (ctx) => buildStrategy(ctx),
});

// --- Change log ------------------------------------------------------------------------------

export const listChanges = defineOperation({
  id: "changes.list",
  summary: "List recorded changes, newest first",
  description:
    "Lists the change log of the workspace, newest first: every change to workspace settings, offers, ICPs and campaigns with its version, a one-line summary, who made it and, for proposals, whether it helped. Filter by area, target_id (offer, ICP or campaign id; the workspace id for settings) or since. For the full before and after values of one change use changes.get; for the current state use strategy.get. Changes from before this feature was installed are not listed.",
  effect: "read",
  input: paginationInput.extend({
    area: z.enum(CHANGE_AREAS).optional(),
    target_id: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Offer, ICP or campaign id; the workspace id for settings"),
    since: dateTimeInput().optional().describe("Only changes made at or after this time"),
  }),
  output: paginated(changeItemOutput),
  http: { method: "GET", path: "/v1/changes" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Recent settings changes", input: { area: "settings", limit: 10 } },
    {
      title: "Changes to one campaign this month",
      input: { target_id: EXAMPLE_CAMPAIGN_ID, since: "2026-09-01T00:00:00Z" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const after = input.cursor ? decodeCursor<{ version: number }>(input.cursor) : null;
    const rows = await ctx.db
      .select()
      .from(change_log)
      .where(
        and(
          eq(change_log.workspace_id, workspace.id),
          input.area ? eq(change_log.area, input.area) : undefined,
          input.target_id ? eq(change_log.target_id, input.target_id) : undefined,
          input.since ? gte(change_log.created_at, input.since) : undefined,
          after ? lt(change_log.version, Number(after.version)) : undefined,
        ),
      )
      .orderBy(desc(change_log.version))
      .limit(input.limit + 1);
    const page = toPage(rows, input.limit, (row) => ({ version: row.version }));
    return { ...page, items: await describeChanges(ctx, workspace.id, page.items) };
  },
});

async function changeDetail(ctx: OpContext, row: ChangeLogEntry) {
  const workspace = requireWorkspace(ctx);
  const [described] = await describeChanges(ctx, workspace.id, [row]);
  const undo = row.undone_at ? await findUndoOf(ctx, workspace.id, row.id) : null;
  return {
    ...(described as NonNullable<typeof described>),
    kind: changeKind(row),
    operation: row.operation,
    diff: row.diff,
    reason: row.reason,
    via: row.via,
    proposal_id: row.proposal_id,
    undo_of: row.undo_of,
    undone_by: undo ? { change_id: undo.id, version: undo.version } : null,
  };
}

export const getChange = defineOperation({
  id: "changes.get",
  summary: "Get one change with its values before and after",
  description:
    "Returns one change of the change log: every changed path with its value before and after, the operation, reason, who made it and through which door, the proposal behind it and whether it was undone. Use it before undoing a change or to explain why something is set the way it is. To browse changes use changes.list. A path without a before value did not exist before the change.",
  effect: "read",
  input: z.object({ change_id: idSchema("chg") }),
  output: changeDetailOutput,
  http: { method: "GET", path: "/v1/changes/:change_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "One change", input: { change_id: EXAMPLE_CHANGE_ID } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const row = await findChange(ctx, workspace.id, input.change_id);
    if (!row) throw notFound("Change", input.change_id);
    return changeDetail(ctx, row);
  },
});

const undoOutput = z.object({
  undone: versionRef,
  undo_change: versionRef.nullable(),
  restored: restoredOutput,
  warnings: z.array(z.string()),
  message: z.string(),
});

export const undoChangeOp = defineOperation({
  id: "changes.undo",
  summary: "Undo one change: set its values back",
  description:
    "Sets the paths of one change back to their values before it (a setting that did not exist is removed again) through the same checks as a normal update; the undo is recorded as a new change. Use it when a change made results worse or was a mistake; preview it with dry_run and read it first with changes.get. Creates and deletes cannot be undone (remove or recreate the offer or ICP instead), and a change that a later change still in effect touched fails with a conflict naming that version: undo the later one first. Undoing an undo puts the change it reverted back in effect. Settings changes need the admin scope.",
  effect: "write",
  input: z.object({ change_id: idSchema("chg") }),
  output: z.union([
    undoOutput,
    dryRunOutput(
      z.object({
        change_id: z.string(),
        version: z.number(),
        summary: z.string(),
        restored: restoredOutput,
      }),
    ),
  ]),
  http: { method: "POST", path: "/v1/changes/:change_id/undo" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Undo a change", input: { change_id: EXAMPLE_CHANGE_ID } }],
  handler: async (ctx, input) => {
    const result = await undoChange(ctx, input.change_id, { dryRun: ctx.request.dryRun });
    const [described] = await describeChanges(ctx, result.change.workspace_id, [result.change]);
    if (ctx.request.dryRun) {
      return dryRun(
        {
          change_id: result.change.id,
          version: result.change.version,
          summary: described?.summary ?? "",
          restored: result.restores,
        },
        { warnings: result.warnings },
      );
    }
    return {
      undone: { change_id: result.change.id, version: result.change.version },
      undo_change: result.undo
        ? { change_id: result.undo.changeId, version: result.undo.version }
        : null,
      restored: result.restores,
      warnings: result.warnings,
      message: result.undo
        ? `Undid version ${result.change.version} as version ${result.undo.version}.`
        : `Version ${result.change.version} is undone; the values already matched, so nothing else changed.`,
    };
  },
});

// --- Proposals -------------------------------------------------------------------------------

const proposePreview = z.object({
  operation: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  route: z.enum(["apply_now", "needs_approval"]),
  review_after_days: z.number(),
});

export const proposeChangeOp = defineOperation({
  id: "changes.propose",
  summary: "Propose a change with its reason, evidence and expected outcome",
  description: `Proposes a change as the operation and input it would run (${PROPOSABLE_OPERATIONS.join(", ")}), with the reason (the call's reason field, required here), evidence and the expected outcome. It applies at once when you may make the change yourself (a person holding approve and the operation's scopes, or anyone with those scopes when approvals.agent_changes is auto), otherwise it waits for an owner's approval of kind change; either way it runs through the normal checks and is recorded in the change log. Use it for strategy changes an owner should see and judge; for one-off actions like sending or enrolling call those tools directly. After review_after_days (default ${REVIEW_AFTER_DAYS_DEFAULT}) the same numbers are compared before and after and stored as the outcome with a verdict.`,
  effect: "write",
  input: z.object({
    title: z.string().trim().min(3).max(200).describe("One line, e.g. 'Review every first email'"),
    operation: z
      .string()
      .min(3)
      .max(100)
      .describe("Operation id to run, e.g. campaigns.update or workspaces.update"),
    input: z
      .record(z.string(), z.unknown())
      .describe("The operation's input, exactly as you would pass it to that operation"),
    evidence: z
      .array(evidenceSchema)
      .max(10)
      .default([])
      .describe(
        "What the proposal is based on, e.g. { label: 'positive reply rate', value: '0.8%' }",
      ),
    expected_outcome: z.string().trim().max(500).optional(),
    review_after_days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(REVIEW_AFTER_DAYS_DEFAULT)
      .describe("Days of numbers compared before and after the change (1 to 90)"),
  }),
  output: z.union([proposalOutput.extend({ message: z.string() }), dryRunOutput(proposePreview)]),
  http: { method: "POST", path: "/v1/proposals" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Review every message of a struggling campaign",
      input: {
        title: "Review every message in Dental groups",
        operation: "campaigns.update",
        input: { campaign_id: EXAMPLE_CAMPAIGN_ID, settings: { review_level: "every" } },
        evidence: [
          { label: "positive reply rate, last 14 days", value: "0.8%", ref: EXAMPLE_CAMPAIGN_ID },
        ],
        expected_outcome: "Positive reply rate back above 2% within two weeks",
        review_after_days: 14,
      },
    },
    {
      title: "Let a person book the meetings",
      input: {
        title: "Hand meetings to the owner",
        operation: "workspaces.update",
        input: { settings: { booking: { mode: "handoff" } } },
        expected_outcome: "More booked meetings from interested replies",
      },
    },
  ],
  handler: async (ctx, input) => {
    const result = await proposeChange(ctx, input);
    if ("preview" in result) {
      const { warnings, ...preview } = result.preview;
      return dryRun(preview, { warnings });
    }
    return { ...proposalDetail(result.proposal), message: result.message };
  },
});

export const listProposalsOp = defineOperation({
  id: "proposals.list",
  summary: "List change proposals, newest first",
  description:
    "Lists the workspace's change proposals, newest first, with status (proposed, awaiting_approval, applied, rejected, failed, reverted) and the verdict once results are in. Use it to see what agents proposed, what waits for approval and what helped. For one proposal with its reason, evidence, input and before and after numbers use proposals.get; to decide a waiting one use review_items. Results appear only after review_after_days.",
  effect: "read",
  input: paginationInput.extend({
    status: z.array(z.enum(PROPOSAL_STATUSES)).max(6).optional().describe("Only these statuses"),
  }),
  output: paginated(proposalItemOutput),
  http: { method: "GET", path: "/v1/proposals" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Waiting for approval", input: { status: ["awaiting_approval"] } },
    { title: "Applied changes", input: { status: ["applied"], limit: 10 } },
  ],
  handler: async (ctx, input) => {
    const page = await listProposals(ctx, input);
    return { ...page, items: page.items.map(proposalItem) };
  },
});

export const getProposalOp = defineOperation({
  id: "proposals.get",
  summary: "Get one proposal with its evidence and results",
  description:
    "Returns one change proposal: the operation and input, reason, evidence, expected outcome, status, the approval and change it led to, any error, and after review_after_days the numbers before and after with the verdict (better, worse, flat or unclear). Use it to judge whether a change helped before proposing the next one. To list proposals use proposals.list; to undo the change use changes.undo with its change_id. A verdict is unclear when either window had fewer than 30 sends.",
  effect: "read",
  input: z.object({ proposal_id: idSchema("prop") }),
  output: proposalOutput,
  http: { method: "GET", path: "/v1/proposals/:proposal_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "One proposal", input: { proposal_id: EXAMPLE_PROPOSAL_ID } }],
  handler: async (ctx, input) => proposalDetail(await getProposal(ctx, input.proposal_id)),
});
