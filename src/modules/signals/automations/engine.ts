/**
 * Runs the workspace's automation rules for one detected signal. A rule fires at most once per
 * signal (automation_firings unique on rule + signal, claimed before any action runs), at most
 * `max_fires_per_day` times per UTC day, and one signal runs at most MAX_ACTIONS_PER_SIGNAL
 * actions across all rules.
 */
import { and, asc, count, eq, gte, sql } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { onEvent } from "../../../core/events.js";
import {
  type AutomationActionResult,
  type AutomationFiringStatus,
  type AutomationRule,
  automation_firings,
  automation_rules,
  companies,
  people,
  signals,
} from "../../../db/schema/index.js";
import { inWorkspace } from "../workspace-context.js";
import { enrollEventAvailable, executeAction } from "./actions.js";
import { type AutomationSubject, evaluateRuleFilters } from "./filters.js";
import {
  DEFAULT_MAX_FIRES_PER_DAY,
  MAX_ACTIONS_PER_SIGNAL,
  readFilters,
  SIGNAL_DETECTED,
  type StoredAction,
} from "./schema.js";

export interface RuleOutcome {
  rule_id: string;
  status: AutomationFiringStatus | "not_matched" | "already_fired";
  reason?: string;
  results?: AutomationActionResult[];
}

export interface AutomationRunResult {
  signal_id: string;
  rules_checked: number;
  outcomes: RuleOutcome[];
}

export interface RunAutomationsOptions {
  /** Overrides the check for the automation.enroll_requested event (tests). */
  enrollEventAvailable?: boolean;
}

/** The signal with its company and person, or null when the signal is gone. */
export async function loadSubject(
  ctx: OpContext,
  workspaceId: string,
  signalId: string,
): Promise<AutomationSubject | null> {
  const [signal] = await ctx.db
    .select()
    .from(signals)
    .where(and(eq(signals.workspace_id, workspaceId), eq(signals.id, signalId)));
  if (!signal) return null;
  const [company] = signal.company_id
    ? await ctx.db
        .select()
        .from(companies)
        .where(and(eq(companies.workspace_id, workspaceId), eq(companies.id, signal.company_id)))
    : [];
  const [person] = signal.person_id
    ? await ctx.db
        .select()
        .from(people)
        .where(and(eq(people.workspace_id, workspaceId), eq(people.id, signal.person_id)))
    : [];
  return { signal, company: company ?? null, person: person ?? null };
}

/** Enabled rules triggered by signal.detected, oldest first. */
export async function signalRules(ctx: OpContext, workspaceId: string): Promise<AutomationRule[]> {
  return ctx.db
    .select()
    .from(automation_rules)
    .where(
      and(
        eq(automation_rules.workspace_id, workspaceId),
        eq(automation_rules.enabled, true),
        sql`${automation_rules.trigger}->>'event' = ${SIGNAL_DETECTED}`,
      ),
    )
    .orderBy(asc(automation_rules.created_at), asc(automation_rules.id));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function firesToday(ctx: OpContext, ruleId: string, now: Date): Promise<number> {
  const [row] = await ctx.db
    .select({ value: count() })
    .from(automation_firings)
    .where(
      and(
        eq(automation_firings.rule_id, ruleId),
        eq(automation_firings.status, "fired"),
        gte(automation_firings.created_at, startOfUtcDay(now)),
      ),
    );
  return Number(row?.value ?? 0);
}

/** Claims the (rule, signal) pair. Returns the firing id, or null when it was claimed before. */
async function claimFiring(
  ctx: OpContext,
  rule: AutomationRule,
  signalId: string,
  status: AutomationFiringStatus,
  results: AutomationActionResult[],
): Promise<string | null> {
  const [row] = await ctx.db
    .insert(automation_firings)
    .values({
      workspace_id: rule.workspace_id,
      rule_id: rule.id,
      signal_id: signalId,
      status,
      results,
      created_at: ctx.clock.now(),
    })
    .onConflictDoNothing({ target: [automation_firings.rule_id, automation_firings.signal_id] })
    .returning({ id: automation_firings.id });
  return row?.id ?? null;
}

export async function runAutomationsForSignal(
  ctx: OpContext,
  signalId: string,
  options: RunAutomationsOptions = {},
): Promise<AutomationRunResult> {
  const workspaceId = ctx.workspace?.id;
  const result: AutomationRunResult = { signal_id: signalId, rules_checked: 0, outcomes: [] };
  if (!workspaceId) return result;
  const subject = await loadSubject(ctx, workspaceId, signalId);
  if (!subject || subject.signal.status === "dismissed") return result;
  const rules = await signalRules(ctx, workspaceId);
  const now = ctx.clock.now();
  const enrollAvailable = options.enrollEventAvailable ?? enrollEventAvailable();
  let actionsLeft = MAX_ACTIONS_PER_SIGNAL;

  for (const rule of rules) {
    result.rules_checked += 1;
    const filters = readFilters(rule.trigger.filters);
    const check = await evaluateRuleFilters(ctx, filters, subject);
    if (!check.ok) {
      result.outcomes.push({ rule_id: rule.id, status: "not_matched", reason: check.reason });
      continue;
    }
    const actions = rule.actions as StoredAction[];
    const cap = filters.max_fires_per_day ?? DEFAULT_MAX_FIRES_PER_DAY;
    let skipReason: string | null = null;
    if ((await firesToday(ctx, rule.id, now)) >= cap) {
      skipReason = `max_fires_per_day (${cap}) reached`;
    } else if (actions.length > actionsLeft) {
      skipReason = `this signal already ran ${MAX_ACTIONS_PER_SIGNAL} automation actions`;
    }
    if (skipReason) {
      const claimed = await claimFiring(ctx, rule, signalId, "skipped", [
        { type: "rule", status: "skipped", detail: skipReason },
      ]);
      result.outcomes.push({
        rule_id: rule.id,
        status: claimed ? "skipped" : "already_fired",
        reason: skipReason,
      });
      continue;
    }

    const firingId = await claimFiring(ctx, rule, signalId, "fired", []);
    if (!firingId) {
      result.outcomes.push({ rule_id: rule.id, status: "already_fired" });
      continue;
    }
    actionsLeft -= actions.length;
    const results: AutomationActionResult[] = [];
    for (const action of actions) {
      results.push(
        await executeAction(
          {
            ctx,
            rule,
            subject,
            people: check.people,
            firingId,
            enrollEventAvailable: enrollAvailable,
          },
          action,
        ),
      );
    }
    const status: AutomationFiringStatus =
      results.length > 0 && results.every((item) => item.status === "failed") ? "failed" : "fired";
    await ctx.db
      .update(automation_firings)
      .set({ status, results })
      .where(eq(automation_firings.id, firingId));
    await ctx.db
      .update(automation_rules)
      .set({ last_fired_at: now })
      .where(eq(automation_rules.id, rule.id));
    result.outcomes.push({ rule_id: rule.id, status, results });
  }
  return result;
}

/** Event handler: automation rules react to every new scored signal. */
export const runAutomationsHandler = onEvent(
  "signal.detected",
  "signals.run_automations",
  async (jobCtx, event) => {
    const ctx = await inWorkspace(jobCtx, event.workspaceId);
    if (!ctx) return;
    const outcome = await runAutomationsForSignal(ctx, event.data.signal_id);
    const fired = outcome.outcomes.filter((item) => item.status === "fired").length;
    if (fired > 0) {
      ctx.log.info({ signal: event.data.signal_id, fired }, "automation rules fired for signal");
    }
  },
  { maxAttempts: 3 },
);
