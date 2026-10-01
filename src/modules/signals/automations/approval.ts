/**
 * Letting an automation enroll people without asking a person first is a gate (spec 2, rule 4):
 * `require_approval` false on a rule with enroll actions, and, on a rule that already enrolls
 * that way, a change to its filters or enroll actions (who it enrolls). Someone who must ask
 * for approval (`mustRequestApproval`) gets an approval of kind `automation_approval` instead:
 * the rule keeps asking before each enrollment, or keeps its filters and actions, until a person
 * approves. Turning approvals on never needs one. An approval applies what it showed: its
 * payload holds a fingerprint of the rule, and a rule that changed since answers `conflict`.
 */
import { and, eq } from "drizzle-orm";
import { stableHash } from "../../../brain/hash.js";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import type { ApprovalApplyResult, ApprovalResolver } from "../../../core/operation.js";
import {
  type AutomationAction,
  type AutomationRule,
  automation_rules,
} from "../../../db/schema/index.js";
import { publicActions } from "../shapes.js";
import type { StoredAction } from "./schema.js";

/** True when the rule would enroll people without an approval for each enrollment. */
export function enrollsUnattended(rule: {
  require_approval: boolean;
  actions: ReadonlyArray<{ type: string }>;
}): boolean {
  return !rule.require_approval && rule.actions.some((action) => action.type === "enroll");
}

type RuleShape = Pick<AutomationRule, "trigger" | "actions" | "require_approval">;

/** What a request covers: the rule's filters, actions and approval setting. */
export function ruleFingerprint(rule: RuleShape): string {
  return stableHash({
    filters: rule.trigger.filters ?? {},
    actions: rule.actions,
    require_approval: rule.require_approval,
  });
}

/** The rule's filters and actions in plain JSON (webhook secrets never shown). */
export function describeRule(
  filters: Record<string, unknown> | undefined,
  actions: readonly AutomationAction[],
): string {
  const set = filters && Object.keys(filters).length > 0 ? JSON.stringify(filters) : null;
  return `Filters: ${set ?? "none (every new signal)"}. Actions: ${JSON.stringify(publicActions([...actions]))}.`;
}

/** A change to who a rule that enrolls without approval enrolls: its new filters and actions. */
export interface HeldRuleChange {
  filters: Record<string, unknown>;
  actions: StoredAction[];
}

/**
 * Stores the approval: to turn approvals off on the rule as it is now, or (`change`) to give a
 * rule that already enrolls without approval new filters and actions. A newer request for the
 * rule replaces an older one.
 */
export async function requestUnattendedApproval(
  ctx: OpContext,
  rule: Pick<AutomationRule, "id" | "name" | "trigger" | "actions" | "require_approval">,
  change?: HeldRuleChange,
): Promise<string> {
  const now = describeRule(rule.trigger.filters, rule.actions);
  const { id } = await ctx.approvals.request({
    kind: "automation_approval",
    title: change
      ? `Change who automation "${rule.name}" enrolls without approval`
      : `Let automation "${rule.name}" enroll people without approval`,
    summary: change
      ? `${ctx.principal.name} asked to change the filters or enroll actions of automation "${rule.name}", which adds people to campaigns without a person approving each enrollment. Until a decision it keeps what it has. Now: ${now} Asked for: ${describeRule(change.filters, change.actions as AutomationAction[])} Approve to apply the new filters and actions; reject to keep the current ones.`
      : `${ctx.principal.name} asked to turn off require_approval on automation "${rule.name}": its enroll actions would then add people to campaigns without a person approving each enrollment. ${now} Until a decision, every enrollment it makes still waits for approval. Approve to turn approvals off; reject to keep them on.`,
    payload: {
      rule_id: rule.id,
      name: rule.name,
      require_approval: false,
      ...(change ? { filters: change.filters, actions: change.actions } : {}),
      fingerprint: ruleFingerprint(rule),
    },
    target: { type: "automation_rule", id: rule.id },
    supersede: true,
  });
  return id;
}

/** Removes vault secrets of webhook actions that are gone from a rule. */
export async function dropUnusedSecrets(
  ctx: OpContext,
  before: readonly AutomationAction[],
  after: readonly StoredAction[],
): Promise<void> {
  const kept = new Set(
    after.flatMap((action) =>
      action.type === "webhook" && action.secret_id ? [action.secret_id] : [],
    ),
  );
  for (const action of before) {
    if (
      action.type === "webhook" &&
      typeof action.secret_id === "string" &&
      !kept.has(action.secret_id)
    ) {
      await ctx.vault.deleteSecret(action.secret_id);
    }
  }
}

export const automationApprovalResolver: ApprovalResolver = {
  kind: "automation_approval",
  apply: async (ctx, approval, decision): Promise<ApprovalApplyResult> => {
    const ruleId = String(approval.target_id ?? approval.payload.rule_id ?? "");
    const target = { type: "automation_rule", id: ruleId };
    const change = Array.isArray(approval.payload.actions)
      ? {
          filters: (approval.payload.filters ?? {}) as Record<string, unknown>,
          actions: approval.payload.actions as StoredAction[],
        }
      : null;
    if (decision.decision === "reject") {
      return {
        message: change
          ? "Rejected: the rule keeps its filters and actions."
          : "Rejected: the rule keeps asking for approval before it enrolls anyone.",
        target,
      };
    }
    const workspace = requireWorkspace(ctx);
    const rule = and(
      eq(automation_rules.workspace_id, workspace.id),
      eq(automation_rules.id, ruleId),
    );
    const [current] = await ctx.db.select().from(automation_rules).where(rule);
    if (!current) return { message: "The rule no longer exists; nothing changed.", target };
    if (approval.payload.fingerprint !== ruleFingerprint(current)) {
      throw new OpenOutboundError(
        "conflict",
        `Automation "${current.name}" changed since the request (its filters, actions or approval setting), so this approval no longer shows it; ask again.`,
        {
          hint: "Reject this approval. Whoever asked can ask again (manage_automations action update), and the new request shows the rule as it is now.",
          details: { rule_id: current.id },
        },
      );
    }
    const [row] = await ctx.db
      .update(automation_rules)
      .set({
        require_approval: false,
        ...(change
          ? {
              trigger: { ...current.trigger, filters: change.filters },
              actions: change.actions as AutomationAction[],
            }
          : {}),
      })
      .where(rule)
      .returning();
    if (!row) return { message: "The rule no longer exists; nothing changed.", target };
    if (change) await dropUnusedSecrets(ctx, current.actions, change.actions);
    return {
      message: change
        ? `Automation "${row.name}" now enrolls with its new filters and actions, without asking first.`
        : `Automation "${row.name}" now enrolls people without asking first.`,
      target,
      data: { rule_id: row.id, require_approval: false },
    };
  },
};
