/**
 * Change proposals: an agent (or a person) proposes a change as the operation id and input it
 * would run, with a reason, evidence and the expected outcome. It applies at once when the
 * caller has the operation's scopes and may change things on its own (people always; agents
 * when `approvals.agent_changes` is `auto`), otherwise it waits for an approval of kind
 * `change`. Applying calls the operation through the normal executor as the proposer, so every
 * gate runs (scopes, input, idempotency, paused check, budgets, the operation's own approvals,
 * audit); the change log rows it records carry the proposal id.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  type ActorRef,
  actorRef,
  type OpContext,
  type Principal,
  requireWorkspace,
} from "../../core/context.js";
import type { ProposalStatus, Scope } from "../../core/enums.js";
import { forbidden, notFound, OpenOutboundError, toOpenOutboundError } from "../../core/errors.js";
import {
  type AnyOperation,
  type ApprovalResolver,
  onEvent,
  operationScopes,
  RESERVED_INPUT_FIELDS,
} from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import {
  type ChangeProposal,
  change_log,
  change_proposals,
  type ProposalEvidence,
} from "../../db/schema/index.js";
import { mustRequestApproval } from "../../runtime/approval-rule.js";
import { callOperationAs, registeredOperation } from "../../runtime/call-as.js";
import { type ChangeScope, runInChangeScope } from "./change-scope.js";

/**
 * Operations a proposal may run. Ids are resolved when a proposal is made, so an operation a
 * module has not registered (yet) is refused with a clear error instead of breaking the list.
 */
export const PROPOSABLE_OPERATIONS = [
  "workspaces.update",
  "campaigns.update",
  "campaigns.pause",
  "campaigns.pick_winner",
  "offers.create",
  "offers.update",
  "icps.create",
  "icps.update",
  "signals.definitions.create",
  "signals.definitions.update",
  "signals.automations.create",
  "signals.automations.update",
  "mailboxes.update",
] as const;

export const REVIEW_AFTER_DAYS_DEFAULT = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const INPUT_MAX_CHARS = 20_000;
/** Credentials never go into a stored proposal: they are changed directly. */
const CREDENTIAL_KEY = /password|secret$|token$|api_key/i;

export interface ProposeInput {
  title: string;
  evidence?: ProposalEvidence[] | undefined;
  expected_outcome?: string | null | undefined;
  operation: string;
  input: Record<string, unknown>;
  review_after_days?: number | undefined;
}

export type ProposalRoute = "apply_now" | "needs_approval";

export interface ProposeResult {
  proposal: ChangeProposal;
  message: string;
}

export interface ProposePreview {
  operation: string;
  target_type: string | null;
  target_id: string | null;
  route: ProposalRoute;
  review_after_days: number;
  warnings: string[];
}

/** Target type and the input field holding the target id, by operation prefix. */
const TARGETS: Array<{ prefix: string; type: string; field: string | null }> = [
  { prefix: "workspaces.", type: "workspace", field: null },
  { prefix: "campaigns.", type: "campaign", field: "campaign_id" },
  { prefix: "offers.", type: "offer", field: "offer_id" },
  { prefix: "icps.", type: "icp", field: "icp_id" },
  { prefix: "signals.definitions.", type: "signal_definition", field: "key" },
  { prefix: "signals.automations.", type: "automation_rule", field: "rule_id" },
  { prefix: "mailboxes.", type: "mailbox", field: "mailbox_id" },
];

function targetTypeOf(operation: string): string | null {
  return TARGETS.find((target) => operation.startsWith(target.prefix))?.type ?? null;
}

/** Where the proposal points: the record the operation changes (null for creates). */
export function inferTarget(
  operation: string,
  input: Record<string, unknown>,
  workspaceId: string,
): { type: string; id: string } | null {
  const target = TARGETS.find((candidate) => operation.startsWith(candidate.prefix));
  if (!target) return null;
  if (target.field === null) return { type: target.type, id: workspaceId };
  const id = input[target.field];
  return typeof id === "string" && id ? { type: target.type, id } : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first credential-like key anywhere in the input, e.g. "password". */
function credentialKey(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = credentialKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key) && item !== undefined && item !== null) return key;
    const found = credentialKey(item, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The registered operations of the allowlist (unknown ones are left out). */
export function availableOperations(ctx: OpContext): string[] {
  return PROPOSABLE_OPERATIONS.filter((id) => registeredOperation(ctx, id) !== undefined);
}

/**
 * Resolves and checks the operation and input of a proposal: allowlisted, registered, no
 * executor fields, no credentials, valid for the operation's input schema.
 */
export function checkProposal(
  ctx: OpContext,
  operation: string,
  input: unknown,
): { op: AnyOperation; input: Record<string, unknown> } {
  const available = availableOperations(ctx);
  if (!(PROPOSABLE_OPERATIONS as readonly string[]).includes(operation)) {
    throw new OpenOutboundError(
      "validation_failed",
      `${operation} cannot be proposed. Allowed operations: ${available.join(", ")}.`,
      {
        hint: "Propose one of the allowed operations, or run the operation directly if your key may.",
        details: { field: "operation", allowed: available },
      },
    );
  }
  const op = registeredOperation(ctx, operation);
  if (!op) {
    throw new OpenOutboundError(
      "validation_failed",
      `${operation} is not available in this engine, so it cannot be proposed.`,
      {
        hint: `Propose one of: ${available.join(", ")}.`,
        details: { field: "operation", allowed: available },
      },
    );
  }
  if (!isPlainObject(input)) {
    throw new OpenOutboundError("validation_failed", "input must be an object.", {
      hint: `Pass the fields ${operation} takes, e.g. ${JSON.stringify(op.examples[0]?.input ?? {})}.`,
      details: { field: "input" },
    });
  }
  const reserved = Object.keys(input).filter((key) =>
    (RESERVED_INPUT_FIELDS as readonly string[]).includes(key),
  );
  if (reserved.length > 0) {
    throw new OpenOutboundError(
      "validation_failed",
      `input cannot contain ${reserved.join(", ")}: the proposal sets the workspace, reason and idempotency itself.`,
      { hint: `Remove ${reserved.join(", ")} from input.`, details: { fields: reserved } },
    );
  }
  const credential = credentialKey(input);
  if (credential) {
    throw new OpenOutboundError(
      "validation_failed",
      `Proposals cannot carry credentials (${credential}): they would be stored in plain text.`,
      {
        hint: `Leave ${credential} out of the proposal and set it directly with the tool that owns it.`,
        details: { field: credential },
      },
    );
  }
  if (JSON.stringify(input).length > INPUT_MAX_CHARS) {
    throw new OpenOutboundError(
      "validation_failed",
      `input is too large for a proposal (over ${INPUT_MAX_CHARS} characters).`,
      { hint: "Split the change into smaller proposals." },
    );
  }
  const parsed = op.input.safeParse(input);
  if (!parsed.success) {
    const failure = toOpenOutboundError(parsed.error);
    throw new OpenOutboundError(
      "validation_failed",
      `The input for ${operation} is not valid: ${failure.message}`,
      {
        hint: `Fix the listed fields. Example input for ${operation}: ${JSON.stringify(op.examples[0]?.input ?? {}).slice(0, 300)}`,
        ...(failure.details ? { details: failure.details } : {}),
      },
    );
  }
  return { op, input };
}

/**
 * Whether the principal may apply the change without an approval: it needs the operation's
 * scopes, and either is a person holding approve (`mustRequestApproval`) or the workspace lets
 * proposals apply on their own (`approvals.agent_changes: auto`, for everyone).
 */
export function proposalRoute(
  principal: Principal,
  op: AnyOperation,
  agentChanges: "approve" | "auto",
): { route: ProposalRoute; missingScopes: Scope[] } {
  const missingScopes = operationScopes(op).filter((scope) => !principal.scopes.includes(scope));
  if (missingScopes.length > 0) return { route: "needs_approval", missingScopes };
  const needsOwner = mustRequestApproval(principal) && agentChanges !== "auto";
  return { route: needsOwner ? "needs_approval" : "apply_now", missingScopes };
}

function isAwaitingApproval(output: unknown): output is { status: string; approval_id: string } {
  return (
    isPlainObject(output) &&
    output.status === "awaiting_approval" &&
    typeof output.approval_id === "string"
  );
}

/** The proposer as a principal that may run exactly this operation (after an approval). */
function proposerPrincipal(
  createdBy: ActorRef | null,
  op: AnyOperation,
  workspaceId: string,
): Principal {
  const actor = createdBy ?? { type: "system" as const, id: "system", name: "OpenOutbound" };
  return {
    type: actor.type,
    id: actor.id,
    name: actor.name,
    via: actor.via ?? "system",
    scopes: [...new Set<Scope>(["read", ...operationScopes(op)])],
    workspaceId,
  };
}

async function updateProposal(
  ctx: OpContext,
  proposal: ChangeProposal,
  set: Partial<ChangeProposal>,
): Promise<ChangeProposal> {
  const [row] = await ctx.db
    .update(change_proposals)
    .set({ ...set, updated_at: ctx.clock.now() })
    .where(
      and(
        eq(change_proposals.id, proposal.id),
        eq(change_proposals.workspace_id, proposal.workspace_id),
      ),
    )
    .returning();
  return row ?? { ...proposal, ...set };
}

/**
 * The applied change's target, from the input that was applied (an owner may have edited it,
 * e.g. to another campaign), else from the change log row or the created record (creates).
 */
async function appliedTarget(
  ctx: OpContext,
  proposal: ChangeProposal,
  input: Record<string, unknown>,
  changeId: string | null,
  output: unknown,
): Promise<{ target_type: string | null; target_id: string | null }> {
  const target = inferTarget(proposal.operation, input, proposal.workspace_id);
  if (target) return { target_type: target.type, target_id: target.id };
  if (changeId) {
    const [row] = await ctx.db
      .select({ area: change_log.area, target_id: change_log.target_id })
      .from(change_log)
      .where(eq(change_log.id, changeId));
    if (row?.target_id) return { target_type: row.area, target_id: row.target_id };
  }
  if (isPlainObject(output) && typeof output.id === "string") {
    return {
      target_type: proposal.target_type ?? targetTypeOf(proposal.operation),
      target_id: output.id,
    };
  }
  return { target_type: proposal.target_type, target_id: proposal.target_id };
}

/**
 * Runs the proposal's operation through the executor as `principal` and stores what happened:
 * applied (with the last change log row and the review date), awaiting_approval (the
 * operation's own approval), or failed (with the error). Never throws for a failed operation.
 */
async function applyProposal(
  ctx: OpContext,
  proposal: ChangeProposal,
  principal: Principal,
  input: Record<string, unknown>,
  decidedBy: ActorRef | null,
): Promise<ChangeProposal> {
  const scope: ChangeScope = {
    workspaceId: proposal.workspace_id,
    proposalId: proposal.id,
    recorded: [],
  };
  const decided = decidedBy ? { decided_by: decidedBy } : {};
  let output: unknown;
  try {
    output = await runInChangeScope(scope, () =>
      callOperationAs(ctx, proposal.operation, input, {
        principal,
        workspace: proposal.workspace_id,
        idempotencyKey: `proposal:${proposal.id}`,
        reason: `Proposal ${proposal.id}: ${proposal.reason}`.slice(0, 500),
        dryRun: false,
      }),
    );
  } catch (error) {
    const failure = toOpenOutboundError(error);
    return updateProposal(ctx, proposal, {
      ...decided,
      input,
      status: "failed",
      error:
        `${failure.code}: ${failure.message}${failure.hint ? ` Hint: ${failure.hint}` : ""}`.slice(
          0,
          1000,
        ),
    });
  }
  const changeId = scope.recorded.at(-1)?.changeId ?? null;
  if (isAwaitingApproval(output)) {
    const target = inferTarget(proposal.operation, input, proposal.workspace_id);
    return updateProposal(ctx, proposal, {
      ...decided,
      ...(target ? { target_type: target.type, target_id: target.id } : {}),
      input,
      status: "awaiting_approval",
      approval_id: output.approval_id,
      change_id: changeId,
      error: null,
    });
  }
  const now = ctx.clock.now();
  return updateProposal(ctx, proposal, {
    ...decided,
    ...(await appliedTarget(ctx, proposal, input, changeId, output)),
    input,
    status: "applied",
    change_id: changeId,
    error: null,
    applied_at: now,
    review_at: new Date(now.getTime() + proposal.review_after_days * DAY_MS),
  });
}

function approvalSummary(proposal: ChangeProposal, op: AnyOperation): string {
  const expected = proposal.expected_outcome ? ` Expected: ${proposal.expected_outcome}` : "";
  return `${op.summary} (${op.id}) with ${JSON.stringify(proposal.input).slice(0, 400)}. Why: ${proposal.reason}${expected}`.slice(
    0,
    1000,
  );
}

/**
 * Stores a proposal and applies it at once or asks for an approval (see the file comment).
 * The reason comes from the call's `reason` field and is required.
 */
export async function proposeChange(
  ctx: OpContext,
  input: ProposeInput,
): Promise<ProposeResult | { preview: ProposePreview }> {
  const workspace = requireWorkspace(ctx);
  const reason = ctx.request.reason?.trim();
  if (!reason) {
    throw new OpenOutboundError("validation_failed", "A proposal needs a reason.", {
      hint: "Pass reason: why this change should help, in one or two sentences (it is shown to the owner and kept with the change).",
      details: { field: "reason" },
    });
  }
  const checked = checkProposal(ctx, input.operation, input.input);
  const settings = parseWorkspaceSettings(workspace.settings);
  const { route, missingScopes } = proposalRoute(
    ctx.principal,
    checked.op,
    settings.approvals.agent_changes,
  );
  const target = inferTarget(input.operation, checked.input, workspace.id);
  const reviewAfterDays = input.review_after_days ?? REVIEW_AFTER_DAYS_DEFAULT;
  if (ctx.request.dryRun) {
    const warnings = missingScopes.length
      ? [
          `Your key lacks ${missingScopes.join(", ")} for ${input.operation}: the change waits for an owner's approval.`,
        ]
      : [];
    return {
      preview: {
        operation: input.operation,
        target_type: target?.type ?? null,
        target_id: target?.id ?? null,
        route,
        review_after_days: reviewAfterDays,
        warnings,
      },
    };
  }
  const [created] = await ctx.db
    .insert(change_proposals)
    .values({
      workspace_id: workspace.id,
      title: input.title.trim(),
      reason: reason.slice(0, 2000),
      evidence: input.evidence ?? [],
      expected_outcome: input.expected_outcome?.trim() || null,
      operation: input.operation,
      input: checked.input,
      target_type: target?.type ?? targetTypeOf(input.operation),
      target_id: target?.id ?? null,
      status: "proposed",
      review_after_days: reviewAfterDays,
      created_by: actorRef(ctx.principal),
    })
    .returning();
  if (!created) throw new Error("proposal insert returned no row");

  if (route === "apply_now") {
    const proposal = await applyProposal(ctx, created, ctx.principal, checked.input, null);
    return { proposal, message: resultMessage(proposal) };
  }
  const approval = await ctx.approvals.request({
    kind: "change",
    title: `Change: ${created.title}`.slice(0, 200),
    summary: approvalSummary(created, checked.op),
    payload: {
      proposal_id: created.id,
      operation: created.operation,
      input: created.input,
      reason: created.reason,
      expected_outcome: created.expected_outcome,
      evidence: created.evidence,
    },
    target: { type: "proposal", id: created.id },
  });
  const proposal = await updateProposal(ctx, created, {
    status: "awaiting_approval",
    approval_id: approval.id,
  });
  return {
    proposal,
    message: missingScopes.length
      ? `Waiting for an owner's approval (${approval.id}): your key lacks ${missingScopes.join(", ")} for ${input.operation}.`
      : `Waiting for an owner's approval (${approval.id}); it applies when approved.`,
  };
}

/** One line on what happened to a proposal. */
export function resultMessage(proposal: ChangeProposal): string {
  switch (proposal.status) {
    case "applied":
      return `Applied${proposal.change_id ? ` (change ${proposal.change_id})` : ""}; results are compared after ${proposal.review_after_days} days.`;
    case "awaiting_approval":
      return `Waiting for approval ${proposal.approval_id ?? ""}.`.replace(" .", ".");
    case "failed":
      return `The change failed: ${proposal.error ?? "unknown error"}`;
    case "rejected":
      return "Rejected; nothing changed.";
    case "reverted":
      return "Applied, then undone.";
    default:
      return "Proposed.";
  }
}

/** Approval resolver for kind `change`: approve applies, edit applies `edits.input`, reject rejects. */
export const changeApprovalResolver: ApprovalResolver = {
  kind: "change",
  apply: async (ctx, approval, decision) => {
    const proposalId = String(approval.payload.proposal_id ?? approval.target_id ?? "");
    const target = { type: "proposal", id: proposalId };
    const [proposal] = await ctx.db
      .select()
      .from(change_proposals)
      .where(
        and(
          eq(change_proposals.id, proposalId),
          eq(change_proposals.workspace_id, approval.workspace_id),
        ),
      );
    if (!proposal) return { message: "The proposal no longer exists; nothing changed.", target };
    if (proposal.status !== "awaiting_approval" || proposal.approval_id !== approval.id) {
      return { message: `The proposal is already ${proposal.status}.`, target };
    }
    if (decision.decision === "reject") {
      await updateProposal(ctx, proposal, { status: "rejected", decided_by: decision.decidedBy });
      return { message: "Rejected; nothing changed.", target };
    }
    const op = registeredOperation(ctx, proposal.operation);
    if (!op) {
      const failed = await updateProposal(ctx, proposal, {
        status: "failed",
        decided_by: decision.decidedBy,
        error: `not_found: ${proposal.operation} is no longer available in this engine.`,
      });
      return { message: resultMessage(failed), target };
    }
    let input = proposal.input;
    if (decision.decision === "edit" && decision.edits?.input !== undefined) {
      input = checkProposal(ctx, proposal.operation, decision.edits.input).input;
    }
    // The decider lends the authority: they need the scopes the change needs.
    for (const scope of operationScopes(op)) {
      if (!ctx.principal.scopes.includes(scope)) throw forbidden(scope);
    }
    const principal = proposerPrincipal(proposal.created_by, op, approval.workspace_id);
    // A person holding approve decided this exact change: it still runs as the proposer, but
    // an operation with its own gate (a lower review level, a higher daily limit) does not ask
    // them a second time.
    if (!mustRequestApproval(ctx.principal)) principal.approvedBy = actorRef(ctx.principal);
    const applied = await applyProposal(ctx, proposal, principal, input, decision.decidedBy);
    return {
      message: resultMessage(applied),
      target,
      data: {
        proposal_id: applied.id,
        status: applied.status,
        change_id: applied.change_id,
      },
    };
  },
};

/**
 * A proposal whose operation asked for its own approval follows that approval: approved means
 * applied, rejected means rejected.
 */
export const followOperationApproval = onEvent(
  "approval.decided",
  "strategy.follow_operation_approval",
  async (ctx, event) => {
    if (event.data.kind === "change") return;
    const now = ctx.clock.now();
    const waiting = await ctx.db
      .select()
      .from(change_proposals)
      .where(
        and(
          eq(change_proposals.workspace_id, event.workspaceId),
          eq(change_proposals.approval_id, event.data.approval_id),
          eq(change_proposals.status, "awaiting_approval"),
        ),
      );
    for (const proposal of waiting) {
      const approved = event.data.status === "approved";
      await updateProposal(
        ctx,
        proposal,
        approved
          ? {
              status: "applied",
              applied_at: now,
              review_at: new Date(now.getTime() + proposal.review_after_days * DAY_MS),
            }
          : { status: "rejected" },
      );
    }
  },
);

/** A proposal of the workspace, or `not_found`. */
export async function getProposal(ctx: OpContext, proposalId: string): Promise<ChangeProposal> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(change_proposals)
    .where(
      and(eq(change_proposals.workspace_id, workspace.id), eq(change_proposals.id, proposalId)),
    );
  if (!row) throw notFound("Proposal", proposalId);
  return row;
}

/** Proposals of the workspace, newest first. */
export async function listProposals(
  ctx: OpContext,
  input: { status?: ProposalStatus[] | undefined; limit: number; cursor?: string | undefined },
) {
  const workspace = requireWorkspace(ctx);
  const after = input.cursor ? decodeCursor<{ id: string }>(input.cursor) : null;
  const rows = await ctx.db
    .select()
    .from(change_proposals)
    .where(
      and(
        eq(change_proposals.workspace_id, workspace.id),
        input.status?.length ? inArray(change_proposals.status, input.status) : undefined,
        after ? lt(change_proposals.id, String(after.id)) : undefined,
      ),
    )
    .orderBy(desc(change_proposals.id))
    .limit(input.limit + 1);
  return toPage(rows, input.limit, (row) => ({ id: row.id }));
}
