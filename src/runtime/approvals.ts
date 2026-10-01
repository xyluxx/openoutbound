/**
 * Approvals (spec 6): modules request them, humans (scope `approve`) decide them, and the
 * decision is applied by the resolver registered for the approval kind.
 */
import { isDeepStrictEqual } from "node:util";
import { and, eq, lte, sql } from "drizzle-orm";
import {
  type ActorRef,
  type ApprovalService,
  actorRef,
  type EventBus,
  type OpContext,
  type Principal,
} from "../core/context.js";
import type { ApprovalDecisionKind, ApprovalKind, ApprovalStatus } from "../core/enums.js";
import { OpenOutboundError, toOpenOutboundError } from "../core/errors.js";
import type { ApprovalApplyResult, ApprovalResolver } from "../core/operation.js";
import { parseWorkspaceSettings } from "../core/settings.js";
import type { Db } from "../db/client.js";
import { type Approval, approvals, type Workspace } from "../db/schema/index.js";
import { requesterController } from "./api-keys.js";
import { mustRequestApproval } from "./approval-rule.js";
import type { Kernel } from "./kernel.js";
import { assertInFence, contextFence } from "./workspace-fence.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function createApprovalService(
  kernel: Pick<Kernel, "db" | "clock">,
  scope: { workspace: Workspace | null; principal: Principal; events: EventBus },
): ApprovalService {
  const { db, clock } = kernel;
  // A context bound to a workspace requests approvals only there (see workspace-fence).
  const fence = contextFence(scope.workspace?.id ?? null, scope.principal);

  async function cancel(
    filter: Parameters<ApprovalService["cancel"]>[0],
    reason?: string,
    workspaceId = scope.workspace?.id,
  ): Promise<number> {
    if (!filter.id && !filter.kind && !filter.target) {
      throw new OpenOutboundError("internal", "approvals.cancel needs an id, kind or target.");
    }
    const conditions = [eq(approvals.status, "pending")];
    if (workspaceId) conditions.push(eq(approvals.workspace_id, workspaceId));
    if (filter.id) conditions.push(eq(approvals.id, filter.id));
    if (filter.kind) conditions.push(eq(approvals.kind, filter.kind));
    if (filter.target) {
      conditions.push(eq(approvals.target_type, filter.target.type));
      conditions.push(eq(approvals.target_id, filter.target.id));
    }
    const rows = await db
      .update(approvals)
      .set({ status: "cancelled", decided_at: clock.now(), decision_note: reason ?? null })
      .where(and(...conditions))
      .returning({ id: approvals.id });
    return rows.length;
  }

  return {
    async request(request) {
      const workspaceId = request.workspaceId ?? scope.workspace?.id;
      assertInFence(fence, workspaceId, "request approvals");
      if (!workspaceId) {
        throw new OpenOutboundError("internal", "Approvals belong to a workspace.", {
          hint: "Pass workspaceId to approvals.request when the context has no workspace.",
        });
      }
      let expiresAt = request.expiresAt;
      if (!expiresAt) {
        let workspace = scope.workspace?.id === workspaceId ? scope.workspace : null;
        if (!workspace) {
          workspace =
            (await db.query.workspaces.findFirst({
              where: (table, { eq: equals }) => equals(table.id, workspaceId),
            })) ?? null;
        }
        const days = parseWorkspaceSettings(workspace?.settings ?? {}).approvals.expire_days;
        expiresAt = new Date(clock.now().getTime() + days * DAY_MS);
      }
      if (request.target) {
        // Retries and repeated agent calls must not pile up identical approvals.
        const pending = await db
          .select({ id: approvals.id, payload: approvals.payload })
          .from(approvals)
          .where(
            and(
              eq(approvals.workspace_id, workspaceId),
              eq(approvals.kind, request.kind),
              eq(approvals.status, "pending"),
              eq(approvals.target_type, request.target.type),
              eq(approvals.target_id, request.target.id),
            ),
          );
        const stored = JSON.parse(JSON.stringify(request.payload)) as unknown;
        const same = pending.find((row) => isDeepStrictEqual(row.payload, stored));
        if (same) return { id: same.id, deduplicated: true };
        if (request.supersede && pending.length > 0) {
          await cancel(
            { kind: request.kind, target: request.target },
            "Replaced by a newer request.",
            workspaceId,
          );
        }
      }
      const [row] = await db
        .insert(approvals)
        .values({
          workspace_id: workspaceId,
          kind: request.kind,
          status: "pending",
          title: request.title,
          summary: request.summary,
          payload: request.payload,
          target_type: request.target?.type ?? null,
          target_id: request.target?.id ?? null,
          requested_by: actorRef(scope.principal),
          created_at: clock.now(),
          expires_at: expiresAt,
        })
        .returning({ id: approvals.id });
      if (!row) throw new OpenOutboundError("internal", "Failed to store the approval.");
      await scope.events.emit("approval.requested", {
        workspaceId,
        subject: { type: "approval", id: row.id },
        data: {
          approval_id: row.id,
          kind: request.kind,
          title: request.title,
          target_type: request.target?.type ?? null,
          target_id: request.target?.id ?? null,
        },
      });
      return { id: row.id };
    },

    cancel: (filter, reason) => cancel(filter, reason),
  };
}

export interface DecideInput {
  ids: string[];
  decision: ApprovalDecisionKind;
  edits?: Record<string, unknown>;
  note?: string;
}

export interface DecisionOutcome {
  approval_id: string;
  ok: boolean;
  status: ApprovalStatus | null;
  message: string | null;
  error: { code: string; message: string; hint?: string } | null;
  target: { type: string; id: string } | null;
  data: Record<string, unknown> | null;
}

function outcome(id: string, partial: Partial<DecisionOutcome>): DecisionOutcome {
  return {
    approval_id: id,
    ok: false,
    status: null,
    message: null,
    error: null,
    target: null,
    data: null,
    ...partial,
  };
}

/**
 * Whether `decider` made the request: the same principal (type and id), or one under the same
 * control (`requester` is who holds the requesting key, see `Principal.controller`): an agent
 * and the keys it minted, directly or further down, are one requester. Requests the engine
 * made itself (`system`) belong to nobody, so anyone holding `approve` decides them.
 */
export function isOwnRequest(
  requestedBy: Pick<ActorRef, "type" | "id"> | null | undefined,
  decider: Pick<Principal, "type" | "id" | "controller">,
  requester?: string | null,
): boolean {
  if (!requestedBy || requestedBy.type === "system") return false;
  if (requestedBy.type === decider.type && requestedBy.id === decider.id) return true;
  return Boolean(requester) && requester === (decider.controller ?? decider.id);
}

/** How a decision `edit` may change one payload field: set it, or keep part of its list. */
type EditRule = "replace" | "subset";
const NO_EDITS: Readonly<Record<string, EditRule>> = {};
const TEXT_EDITS: Readonly<Record<string, EditRule>> = { subject: "replace", body: "replace" };

/**
 * The payload fields a decider may change with decision `edit`, for every approval kind: an
 * approval applies what it showed, so its target and everything else stay as requested.
 * `subset` takes a list that keeps some of the requested items and adds none. Kind `custom`
 * takes the fields its module's resolver declares (`editable`).
 */
export function approvalEdits(
  kind: ApprovalKind,
  payload: Record<string, unknown>,
  resolver?: Pick<ApprovalResolver, "editable">,
): Readonly<Record<string, EditRule>> {
  switch (kind) {
    case "message":
      // A resend sends the message as it is.
      return payload.action === "resend" ? NO_EDITS : TEXT_EDITS;
    case "reply":
      return TEXT_EDITS;
    case "post":
      // A republish publishes the post as it is.
      return payload.action === "republish"
        ? NO_EDITS
        : { body: "replace", scheduled_for: "replace" };
    case "review_level":
      // A comment step's request switches it to level, nothing else.
      return typeof payload.step_id === "string" ? NO_EDITS : { review_level: "replace" };
    case "mailbox_limits":
      return { daily_limit: "replace", ramp: "replace" };
    case "change":
      return { input: "replace" };
    case "referral":
      return { email: "replace", name: "replace", title: "replace", campaign_id: "replace" };
    case "lead_import":
      return { candidate_ids: "subset", person_ids: "subset" };
    case "enrollment":
      return { person_ids: "subset" };
    case "custom":
      return Object.fromEntries((resolver?.editable ?? []).map((field) => [field, "replace"]));
    case "campaign_launch":
    case "automation_approval":
    case "comment":
    case "spend":
      return NO_EDITS;
  }
}

/** Why `edits` cannot be applied to the approval, or null when every change is allowed. */
function editRefusal(
  row: Approval,
  edits: Record<string, unknown>,
  resolver: ApprovalResolver | undefined,
): { code: string; message: string; hint: string } | null {
  const rules = approvalEdits(row.kind, row.payload, resolver);
  const allowed = Object.keys(rules);
  if (allowed.length === 0) {
    return {
      code: "validation_failed",
      message: `Approval ${row.id} (${row.kind}) takes no edits.`,
      hint: "Approve or reject it as it is with review_items action decide.",
    };
  }
  const other = Object.keys(edits).filter((field) => !rules[field]);
  if (other.length > 0) {
    return {
      code: "validation_failed",
      message: `Approval ${row.id} (${row.kind}) cannot change ${other.join(", ")}: an edit changes only ${allowed.join(", ")}.`,
      hint: "Its target and other fields stay as the request showed them. Reject it and ask for a new request to change them.",
    };
  }
  for (const [field, rule] of Object.entries(rules)) {
    if (rule !== "subset" || !(field in edits)) continue;
    const asked = row.payload[field];
    const kept = edits[field];
    const requested = new Set(Array.isArray(asked) ? asked.map(String) : []);
    if (
      !Array.isArray(kept) ||
      kept.length === 0 ||
      kept.some((item) => typeof item !== "string" || !requested.has(item))
    ) {
      return {
        code: "validation_failed",
        message: `Approval ${row.id} (${row.kind}): ${field} may only keep items the request listed (drop some, add none).`,
        hint: `Pass ${field} as a shorter list of the requested ids, or reject the approval.`,
      };
    }
  }
  return null;
}

/**
 * Applies one decision to each approval (bulk). Each approval is claimed atomically (pending ->
 * approved/rejected), then its kind's resolver runs with the decider's context; if the resolver
 * fails the approval goes back to pending and the error is reported for that id only.
 *
 * Nobody approves their own request (spec 2, rule 5): a decider who must ask for approval
 * (`mustRequestApproval`: agents, services, the local agent, even when given `approve`) is
 * refused (`forbidden`) on a request it made, which stays pending for a person. A person holding
 * `approve` may decide a request they made themselves, since they could have made the change
 * directly (an `ask_first` saved search they ran, for example).
 */
export async function decideApprovals(
  ctx: OpContext,
  kernel: Pick<Kernel, "registry">,
  input: DecideInput,
): Promise<DecisionOutcome[]> {
  const workspace = ctx.workspace;
  if (!workspace) throw new OpenOutboundError("validation_failed", "Approvals need a workspace.");
  const decidedBy: ActorRef = actorRef(ctx.principal);
  const results: DecisionOutcome[] = [];
  for (const id of [...new Set(input.ids)]) {
    const [row] = await ctx.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.workspace_id, workspace.id)))
      .limit(1);
    if (!row) {
      results.push(
        outcome(id, {
          error: {
            code: "not_found",
            message: `Approval ${id} not found.`,
            hint: "List pending approvals with review_items action list.",
          },
        }),
      );
      continue;
    }
    if (row.status !== "pending") {
      results.push(
        outcome(id, {
          status: row.status,
          error: { code: "conflict", message: `Approval ${id} is already ${row.status}.` },
        }),
      );
      continue;
    }
    if (
      mustRequestApproval(ctx.principal) &&
      isOwnRequest(
        row.requested_by,
        ctx.principal,
        await requesterController(ctx.db, row.requested_by),
      )
    ) {
      const by = row.requested_by;
      const message =
        by && (by.type !== decidedBy.type || by.id !== decidedBy.id)
          ? `Approval ${id} was requested by ${by.name} (${by.id}), a key that answers to the same agent as ${decidedBy.name} (${decidedBy.id}): keys an agent creates count as the agent, so it cannot decide it.`
          : `Approval ${id} was requested by ${decidedBy.name} (${decidedBy.id}), who cannot also decide it.`;
      results.push(
        outcome(id, {
          status: "pending",
          error: {
            code: "forbidden",
            message,
            hint: "Ask a person with the approve scope to decide it with review_items action decide (CLI: openoutbound approvals decide).",
          },
        }),
      );
      continue;
    }
    const now = ctx.clock.now();
    if (row.expires_at && row.expires_at.getTime() <= now.getTime()) {
      await ctx.db
        .update(approvals)
        .set({ status: "expired", decided_at: now })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending")));
      results.push(
        outcome(id, {
          status: "expired",
          error: {
            code: "conflict",
            message: `Approval ${id} expired on ${row.expires_at.toISOString()}.`,
          },
        }),
      );
      continue;
    }
    const resolver = kernel.registry.approvalResolver(row.kind);
    const edited = input.decision === "edit";
    const refusal = edited ? editRefusal(row, input.edits ?? {}, resolver) : null;
    if (refusal) {
      results.push(outcome(id, { status: "pending", error: refusal }));
      continue;
    }
    const status: ApprovalStatus = input.decision === "reject" ? "rejected" : "approved";
    const [claimed] = await ctx.db
      .update(approvals)
      .set({
        status,
        decided_by: decidedBy,
        decided_at: now,
        decision_note: input.note ?? null,
        edited,
        payload: edited ? { ...row.payload, ...input.edits } : row.payload,
      })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
      .returning();
    if (!claimed) {
      results.push(
        outcome(id, {
          error: { code: "conflict", message: `Approval ${id} was decided meanwhile.` },
        }),
      );
      continue;
    }
    let applied: ApprovalApplyResult;
    try {
      applied = resolver
        ? await resolver.apply(ctx, claimed, {
            decision: input.decision,
            ...(edited && input.edits ? { edits: input.edits } : {}),
            ...(input.note ? { note: input.note } : {}),
            decidedBy,
          })
        : { message: `Decision recorded. No module handles "${row.kind}" approvals.` };
    } catch (error) {
      await revert(ctx.db, row);
      const failure = toOpenOutboundError(error);
      if (failure.code === "internal")
        ctx.log.error({ err: error, approval_id: id }, "approval resolver failed");
      results.push(
        outcome(id, {
          status: "pending",
          error: {
            code: failure.code,
            message: failure.message,
            ...(failure.hint ? { hint: failure.hint } : {}),
          },
        }),
      );
      continue;
    }
    await ctx.events.emit("approval.decided", {
      workspaceId: workspace.id,
      subject: { type: "approval", id },
      data: { approval_id: id, kind: row.kind, decision: input.decision, status },
    });
    results.push(
      outcome(id, {
        ok: true,
        status,
        message: applied.message ?? null,
        target: applied.target ?? null,
        data: applied.data ?? null,
      }),
    );
  }
  return results;
}

async function revert(db: Db, original: Approval): Promise<void> {
  await db
    .update(approvals)
    .set({
      status: "pending",
      decided_by: null,
      decided_at: null,
      decision_note: null,
      edited: original.edited,
      payload: original.payload,
    })
    .where(eq(approvals.id, original.id));
}

/** Marks pending approvals past their expiry as expired. Returns how many. */
export async function expireApprovals(db: Db, now: Date): Promise<number> {
  const rows = await db
    .update(approvals)
    .set({ status: "expired", decided_at: now })
    .where(and(eq(approvals.status, "pending"), lte(approvals.expires_at, now)))
    .returning({ id: approvals.id });
  return rows.length;
}

/** Pending approval counts by kind for a workspace. */
export async function pendingApprovalCounts(
  db: Db,
  workspaceId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ kind: approvals.kind, count: sql<number>`count(*)`.mapWith(Number) })
    .from(approvals)
    .where(and(eq(approvals.workspace_id, workspaceId), eq(approvals.status, "pending")))
    .groupBy(approvals.kind);
  return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
}
