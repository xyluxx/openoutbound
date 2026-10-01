/**
 * Workspace settings that hold a gate (spec 2, rule 4): the launch approval for agents, the
 * approval of change proposals, the default review level of new campaigns, the AI and data
 * budgets, and replies sent without review (`auto_reply`). Raising safety never needs an
 * approval; loosening it is for a person holding `approve` only. Someone who must ask
 * (`mustRequestApproval`) gets `forbidden` naming the fields, with a hint to propose the change
 * (`manage_strategy` action `propose`, operation `workspaces.update`), which a person approves.
 * Every settings write checks it: workspaces.update, an undo, a setup import, a new workspace.
 */
import type { Principal } from "../../core/context.js";
import { REPLY_CATEGORIES } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { askToChangeSetting, askToRaiseBudget } from "../../core/setting-hints.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../core/settings.js";
import { mustRequestApproval } from "../../runtime/approval-rule.js";
import { lowersReviewLevel } from "../campaigns/review-level.js";

const BUDGETS = ["ai.monthly_budget_usd", "data.monthly_credit_budget"] as const;

/** A budget that is raised, or removed (null is no limit). No limit before: any limit is lower. */
function raisesBudget(before: number | null, after: number | null): boolean {
  if (before === null) return false;
  return after === null || after > before;
}

function parsed(raw: unknown): WorkspaceSettings | null {
  try {
    return parseWorkspaceSettings(raw ?? {});
  } catch {
    return null;
  }
}

/**
 * Paths (below `settings`) whose new value loosens a gate, in a fixed order. Settings that do
 * not parse give none: the write that stores them refuses them first.
 */
export function loosenedGates(before: unknown, after: unknown): string[] {
  const was = parsed(before);
  const now = parsed(after);
  if (!was || !now) return [];
  const fields: string[] = [];
  if (
    was.approvals.agent_launch_requires_approval &&
    !now.approvals.agent_launch_requires_approval
  ) {
    fields.push("approvals.agent_launch_requires_approval");
  }
  if (was.approvals.agent_changes !== "auto" && now.approvals.agent_changes === "auto") {
    fields.push("approvals.agent_changes");
  }
  if (lowersReviewLevel(was.approvals.default_review_level, now.approvals.default_review_level)) {
    fields.push("approvals.default_review_level");
  }
  if (raisesBudget(was.ai.monthly_budget_usd, now.ai.monthly_budget_usd)) {
    fields.push("ai.monthly_budget_usd");
  }
  if (raisesBudget(was.data.monthly_credit_budget, now.data.monthly_credit_budget)) {
    fields.push("data.monthly_credit_budget");
  }
  for (const category of REPLY_CATEGORIES) {
    if (
      was.replies[category].action !== "auto_reply" &&
      now.replies[category].action === "auto_reply"
    ) {
      fields.push(`replies.${category}.action`);
    }
  }
  return fields;
}

function valueAt(settings: WorkspaceSettings, path: string): unknown {
  let node: unknown = settings;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | null)?.[key];
  return node;
}

/**
 * The refusal for a settings write from `before` to `after` by `principal`, or null when the
 * principal is a person holding approve or the write loosens no gate.
 */
export function loosenedGateRefusal(
  principal: Pick<Principal, "type" | "scopes" | "approvedBy">,
  before: unknown,
  after: unknown,
): OpenOutboundError | null {
  if (!mustRequestApproval(principal)) return null;
  const fields = loosenedGates(before, after);
  if (fields.length === 0) return null;
  const now = parseWorkspaceSettings(after ?? {});
  const gates = fields.filter((field) => !(BUDGETS as readonly string[]).includes(field));
  const budgets = fields.filter((field) => (BUDGETS as readonly string[]).includes(field));
  const agentChanges = parseWorkspaceSettings(before ?? {}).approvals.agent_changes;
  const hints: string[] = [];
  if (gates.length > 0) {
    hints.push(
      agentChanges === "auto"
        ? `Ask a person holding approve to change ${gates.map((field) => `settings.${field}`).join(", ")} (openoutbound workspaces update): proposals here apply at once as their proposer (settings.approvals.agent_changes is auto), so one would be refused the same way.`
        : `${askToChangeSetting(Object.fromEntries(gates.map((field) => [field, valueAt(now, field)])))} A person holding approve decides the proposal.`,
    );
  }
  for (const field of budgets)
    hints.push(`A budget is the owner's call: ${askToRaiseBudget(field)}.`);
  const names = fields.map((field) => `settings.${field}`);
  return new OpenOutboundError(
    "forbidden",
    `Changing ${names.join(", ")} loosens a gate, which only a person holding the approve scope may do; nothing was changed.`,
    {
      hint: hints.join(" "),
      details: { fields: names, operation: "workspaces.update" },
    },
  );
}
