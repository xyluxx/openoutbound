import type { OpContext } from "../../../core/context.js";
import type { Workspace } from "../../../db/schema/index.js";
import { pendingApprovals } from "./approvals.js";
import { hotReplies } from "./hot-replies.js";
import { openKnowledgeGaps } from "./knowledge-gaps.js";
import { openProblems } from "./problems.js";
import type { AttentionOutput, ProblemAttention } from "./schema.js";
import { setupChecklist } from "./setup.js";
import { buildSuggestions } from "./suggestions.js";
import { tasksDue } from "./tasks-due.js";
import { collectWarnings } from "./warnings.js";

/** Everything that needs a human or an agent right now, most urgent first (spec 11.12). */
export async function buildAttention(
  ctx: OpContext,
  workspace: Workspace,
  options: { maxItems: number },
): Promise<AttentionOutput> {
  const now = ctx.clock.now();
  const [approvals, hot, gaps, health, suggestions, problems, tasks] = await Promise.all([
    pendingApprovals(ctx.db, workspace.id, now, options.maxItems),
    hotReplies(ctx.db, workspace.id, now, options.maxItems),
    openKnowledgeGaps(ctx.db, workspace.id, options.maxItems),
    collectWarnings(ctx, workspace, now),
    buildSuggestions(ctx.db, workspace.id, now),
    openProblems(ctx, workspace, now),
    tasksDue(ctx.db, workspace.id, now),
  ]);
  const setup = await setupChecklist(ctx.db, workspace, health.brainConfigured);

  const result: Omit<AttentionOutput, "next_step"> = {
    workspace: { id: workspace.id, name: workspace.name, status: workspace.status },
    generated_at: now,
    counts: {
      approvals: approvals.total,
      hot_replies: hot.total,
      knowledge_gaps: gaps.total,
      warnings: health.warnings.length,
      setup_remaining: setup.total - setup.done,
      problems: problems.total,
      tasks_due: tasks.total,
    },
    problems,
    approvals,
    hot_replies: hot,
    tasks_due: tasks,
    knowledge_gaps: gaps,
    warnings: health.warnings,
    setup,
    suggestions,
  };
  return { ...result, next_step: nextStep(result) };
}

/** The oldest pending approval of any kind (each kind lists its oldest first). */
function oldestApproval(queue: AttentionOutput["approvals"]) {
  let oldest: AttentionOutput["approvals"]["by_kind"][number]["oldest"][number] | undefined;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const group of queue.by_kind) {
    const first = group.oldest[0];
    const ms = first ? new Date(first.created_at).getTime() : Number.NaN;
    if (first && ms < oldestMs) {
      oldest = first;
      oldestMs = ms;
    }
  }
  return oldest;
}

/** A problem as a next step: what it is, its remedy, and how to close it. */
function problemStep(problem: ProblemAttention): string {
  const title = problem.title.trim().replace(/[.\s]+$/, "");
  const remedy = problem.remedy.trim();
  if (problem.kind === "send_unknown") {
    // Settling the message closes the problem; resolving only the problem would leave the
    // message unknown for good.
    const settle = remedy.includes("resolve_unknown")
      ? ""
      : " Then settle the message with manage_messages action resolve_unknown (outcome sent, resend or cancel).";
    return `${title}. ${remedy}${settle} Settling the message closes the problem.`;
  }
  // A deletion request closes when the person is forgotten, never with resolve_exception.
  const forget =
    problem.kind === "privacy_request" && remedy.includes("manage_leads action forget");
  const close =
    forget || remedy.includes("resolve_exception")
      ? ""
      : ` Then close it with resolve_exception action resolve (problem_id ${problem.id}).`;
  // The closing words follow the steps, before a suggested reply or other quoted text.
  const [steps = "", ...rest] = remedy.split(/\n\n+/);
  return [`${title}. ${steps}${close}`, ...rest].join("\n\n");
}

/** Open tasks due now, starting with the longest overdue. */
function taskStep(queue: Omit<AttentionOutput, "next_step">): string | null {
  const task = queue.tasks_due.items[0];
  if (!task) return null;
  const total = queue.tasks_due.total;
  const who = task.person_name ? ` for ${task.person_name}` : "";
  const late = task.overdue_hours >= 1 ? ` (due ${Math.round(task.overdue_hours)}h ago)` : "";
  return `${total} ${total === 1 ? "task is" : "tasks are"} due. Start with "${task.title}"${who}${late}, then mark it done with manage_tasks action complete (task_id ${task.id}).`;
}

/**
 * The single most useful next action, in priority order: urgent and high problems, critical
 * warnings, hot replies, approvals, normal problems, tasks due, knowledge gaps, other warnings,
 * low problems, setup, suggestions.
 */
export function nextStep(queue: Omit<AttentionOutput, "next_step">): string {
  // Problems come most severe first, so the first one decides where problems rank.
  const problem = queue.problems.items[0];
  if (problem && (problem.severity === "urgent" || problem.severity === "high")) {
    return problemStep(problem);
  }
  const critical = queue.warnings.find((item) => item.severity === "critical");
  if (critical) return `${critical.message} ${critical.hint}`;
  const hot = queue.hot_replies.items[0];
  if (hot) {
    const who = hot.person_name ?? "a prospect";
    return `Answer ${who}'s ${hot.category} reply (waiting ${hot.waiting_hours}h) with reply_to_thread (thread_id ${hot.thread_id}).`;
  }
  const approvals = queue.approvals.total;
  if (approvals > 0) {
    const oldest = oldestApproval(queue.approvals);
    return `Review ${approvals} pending ${approvals === 1 ? "approval" : "approvals"} with review_items${oldest ? ` (oldest: ${oldest.title})` : ""}.`;
  }
  if (problem?.severity === "normal") return problemStep(problem);
  const task = taskStep(queue);
  if (task) return task;
  const gaps = queue.knowledge_gaps.total;
  if (gaps > 0) {
    return `Answer ${gaps} open prospect ${gaps === 1 ? "question" : "questions"} with manage_knowledge (action answer_gap) so replies can use the answers.`;
  }
  const warning = queue.warnings[0];
  if (warning) return `${warning.message} ${warning.hint}`;
  if (problem) return problemStep(problem);
  const setupItem = queue.setup.items.find((item) => !item.done);
  if (setupItem) return `Next setup step, ${setupItem.label.toLowerCase()}: ${setupItem.hint}`;
  const suggestion = queue.suggestions[0];
  return suggestion ? `${suggestion.message} ${suggestion.hint}` : "Nothing needs attention.";
}
