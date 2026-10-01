/**
 * Erasure of people: GDPR forget (one person, keeps hashed suppressions so they are never
 * imported or contacted again) and the retention sweep (old prospects, keeps suppressions).
 * Both scrub what other tables hold about the person: message and thread content, research
 * briefs, signals, tasks, CRM links and the opportunity and meeting links. Forget also deletes
 * their lead-file facts, resolves their problems, redacts their address in stored copies and
 * emits `lead.forgotten` (CRM external ids and a SHA-256 of the email, nothing readable).
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import {
  approvals,
  crm_links,
  enrollments,
  lead_facts,
  meetings,
  messages,
  opportunities,
  type Person,
  people,
  problems,
  research_briefs,
  signals,
  tasks,
  threads,
} from "../../db/schema/index.js";
import { withTransaction } from "../../runtime/context.js";
import { stopEnrollmentsForPerson } from "../campaigns/service.js";
import { resolveProblem, resolveProblemsFor } from "../problems/service.js";
import { deleteFactsForPerson } from "./facts.js";
import { normalizeEmail, normalizePersonLinkedin } from "./normalize.js";
import {
  emptyRedactionCounts,
  eraseNameInProblems,
  type RedactionCounts,
  type RedactionTargets,
  redactionPattern,
  redactStoredCopies,
} from "./redaction.js";
import {
  addSuppressionRow,
  deletePlainSuppressions,
  hashSuppressionValue,
} from "./suppressions.js";

/** Enrollments that may still send; erasure stops them. */
const OPEN_ENROLLMENT_STATUSES = ["queued", "active", "paused", "waiting_review"] as const;

/** Message statuses that may still go out (queued, scheduled or approved); erasure cancels them. */
export const PENDING_MESSAGE_STATUSES = [
  "draft",
  "generating",
  "pending_review",
  "approved",
  "scheduled",
] as const;

export interface ScrubCounts {
  messages_scrubbed: number;
  messages_cancelled: number;
  threads_scrubbed: number;
  briefs_deleted: number;
  signals_deleted: number;
  tasks_deleted: number;
  opportunities_unlinked: number;
  meetings_unlinked: number;
}

export function emptyScrubCounts(): ScrubCounts {
  return {
    messages_scrubbed: 0,
    messages_cancelled: 0,
    threads_scrubbed: 0,
    briefs_deleted: 0,
    signals_deleted: 0,
    tasks_deleted: 0,
    opportunities_unlinked: 0,
    meetings_unlinked: 0,
  };
}

function count(rows: unknown[]): number {
  return rows.length;
}

/**
 * Removes what other tables hold about these people. With `apply: false` only counts.
 * The people rows themselves are not deleted here.
 */
export async function scrubPeopleData(
  ctx: OpContext,
  personIds: string[],
  apply: boolean,
): Promise<ScrubCounts> {
  const workspace = requireWorkspace(ctx);
  const counts = emptyScrubCounts();
  if (personIds.length === 0) return counts;
  for (let i = 0; i < personIds.length; i += 500) {
    const ids = personIds.slice(i, i + 500);
    const messageWhere = and(
      eq(messages.workspace_id, workspace.id),
      inArray(messages.person_id, ids),
    );
    const pendingWhere = and(messageWhere, inArray(messages.status, [...PENDING_MESSAGE_STATUSES]));
    const threadWhere = and(
      eq(threads.workspace_id, workspace.id),
      inArray(threads.person_id, ids),
    );
    const briefWhere = and(
      eq(research_briefs.workspace_id, workspace.id),
      inArray(research_briefs.person_id, ids),
    );
    const signalWhere = and(
      eq(signals.workspace_id, workspace.id),
      inArray(signals.person_id, ids),
    );
    const taskWhere = and(eq(tasks.workspace_id, workspace.id), inArray(tasks.person_id, ids));
    const opportunityWhere = and(
      eq(opportunities.workspace_id, workspace.id),
      inArray(opportunities.person_id, ids),
    );
    const meetingWhere = and(
      eq(meetings.workspace_id, workspace.id),
      inArray(meetings.person_id, ids),
    );
    if (!apply) {
      const [m] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(messageWhere);
      const [p] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(pendingWhere);
      const [t] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(threads)
        .where(threadWhere);
      const [b] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(research_briefs)
        .where(briefWhere);
      const [s] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(signals)
        .where(signalWhere);
      const [k] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(tasks)
        .where(taskWhere);
      const [o] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(opportunities)
        .where(opportunityWhere);
      const [g] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(meetings)
        .where(meetingWhere);
      counts.messages_scrubbed += m?.n ?? 0;
      counts.messages_cancelled += p?.n ?? 0;
      counts.threads_scrubbed += t?.n ?? 0;
      counts.briefs_deleted += b?.n ?? 0;
      counts.signals_deleted += s?.n ?? 0;
      counts.tasks_deleted += k?.n ?? 0;
      counts.opportunities_unlinked += o?.n ?? 0;
      counts.meetings_unlinked += g?.n ?? 0;
      continue;
    }
    counts.messages_cancelled += count(
      await ctx.db
        .update(messages)
        .set({ status: "cancelled" })
        .where(pendingWhere)
        .returning({ id: messages.id }),
    );
    counts.messages_scrubbed += count(
      await ctx.db
        .update(messages)
        .set({
          person_id: null,
          subject: null,
          body_text: null,
          body_html: null,
          from_address: null,
          to_address: null,
          headers: null,
          why: null,
          check: null,
          classification: null,
          error: null,
        })
        .where(messageWhere)
        .returning({ id: messages.id }),
    );
    counts.threads_scrubbed += count(
      await ctx.db
        .update(threads)
        .set({
          person_id: null,
          subject: null,
          category: null,
          sentiment: null,
          needs_attention: false,
        })
        .where(threadWhere)
        .returning({ id: threads.id }),
    );
    counts.briefs_deleted += count(
      await ctx.db.delete(research_briefs).where(briefWhere).returning({ id: research_briefs.id }),
    );
    counts.signals_deleted += count(
      await ctx.db.delete(signals).where(signalWhere).returning({ id: signals.id }),
    );
    counts.tasks_deleted += count(
      await ctx.db.delete(tasks).where(taskWhere).returning({ id: tasks.id }),
    );
    counts.opportunities_unlinked += count(
      await ctx.db
        .update(opportunities)
        .set({ person_id: null, notes: null })
        .where(opportunityWhere)
        .returning({ id: opportunities.id }),
    );
    counts.meetings_unlinked += count(
      await ctx.db
        .update(meetings)
        .set({ person_id: null, notes: null })
        .where(meetingWhere)
        .returning({ id: meetings.id }),
    );
    await ctx.db
      .delete(crm_links)
      .where(
        and(
          eq(crm_links.workspace_id, workspace.id),
          eq(crm_links.entity_type, "person"),
          inArray(crm_links.entity_id, ids),
        ),
      );
  }
  return counts;
}

export interface ForgetCrmLink {
  provider: string;
  entity_type: string;
  external_id: string;
}

export interface ForgetResult extends ScrubCounts {
  person_id: string | null;
  person_deleted: boolean;
  hashed_suppressions: number;
  plain_suppressions_removed: boolean;
  approvals_cancelled: number;
  enrollments_stopped: number | null;
  /** Lead-file facts and notes about the person, and facts taken from their replies. */
  facts_deleted: number;
  /** Their unresolved problems (and address-only privacy requests), resolved as "forgotten". */
  problems_resolved: number;
  /** Stored copies where their address, profile URL or name was replaced with "[erased]". */
  redacted: RedactionCounts;
  /** The person's CRM records, for the CRM step (`lead.forgotten` carries the same). */
  crm_links: ForgetCrmLink[];
}

/** SHA-256 (hex) of a normalized (lowercased, trimmed) email, as `lead.forgotten` carries it. */
export function emailSha256(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

/**
 * The person's CRM records: their contacts and the deals of their opportunities (a deal can
 * carry their name or notes). Read before the opportunities are unlinked from them.
 */
async function personCrmLinks(ctx: OpContext, personId: string): Promise<ForgetCrmLink[]> {
  const workspace = requireWorkspace(ctx);
  const theirOpportunities = ctx.db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(
      and(eq(opportunities.workspace_id, workspace.id), eq(opportunities.person_id, personId)),
    );
  return ctx.db
    .select({
      provider: crm_links.provider,
      entity_type: crm_links.entity_type,
      external_id: crm_links.external_id,
    })
    .from(crm_links)
    .where(
      and(
        eq(crm_links.workspace_id, workspace.id),
        or(
          and(eq(crm_links.entity_type, "person"), eq(crm_links.entity_id, personId)),
          and(
            eq(crm_links.entity_type, "opportunity"),
            inArray(crm_links.entity_id, theirOpportunities),
          ),
        ),
      ),
    )
    .orderBy(desc(crm_links.entity_type), crm_links.provider, crm_links.external_id);
}

async function inboundMessageIds(ctx: OpContext, personId: string): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.person_id, personId),
        eq(messages.direction, "inbound"),
      ),
    );
  return rows.map((row) => row.id);
}

/** What `deleteFactsForPerson` would delete, for the dry run. */
async function countFacts(ctx: OpContext, personId: string, messageIds: string[]): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const matches: Array<SQL | undefined> = [
    and(eq(lead_facts.scope, "person"), eq(lead_facts.person_id, personId)),
  ];
  if (messageIds.length > 0) {
    matches.push(and(eq(lead_facts.source, "reply"), inArray(lead_facts.source_ref, messageIds)));
  }
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(lead_facts)
    .where(and(eq(lead_facts.workspace_id, workspace.id), or(...matches)));
  return row?.n ?? 0;
}

/**
 * Unresolved problems a forget settles: the person's own, and privacy requests from an address
 * with no person record whose text names the address or profile being forgotten.
 */
async function problemsToResolve(
  ctx: OpContext,
  personId: string | null,
  pattern: string | null,
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const matches: Array<SQL | undefined> = [];
  if (personId) matches.push(eq(problems.person_id, personId));
  if (pattern) {
    matches.push(
      and(
        eq(problems.kind, "privacy_request"),
        isNull(problems.person_id),
        sql`(${problems.title} ~* ${pattern} or ${problems.reason} ~* ${pattern} or ${problems.remedy} ~* ${pattern})`,
      ),
    );
  }
  if (matches.length === 0) return [];
  const rows = await ctx.db
    .select({ id: problems.id })
    .from(problems)
    .where(
      and(eq(problems.workspace_id, workspace.id), ne(problems.status, "resolved"), or(...matches)),
    );
  return rows.map((row) => row.id);
}

/**
 * Pending approvals a real forget cancels: those for the person and for their unsent messages.
 * A dry run counts their redaction the way the real run will, after they are cancelled.
 */
async function approvalsToCancel(ctx: OpContext, personId: string): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspace_id, workspace.id),
        eq(approvals.status, "pending"),
        or(
          and(eq(approvals.target_type, "person"), eq(approvals.target_id, personId)),
          and(
            eq(approvals.target_type, "message"),
            inArray(
              approvals.target_id,
              ctx.db
                .select({ id: messages.id })
                .from(messages)
                .where(
                  and(
                    eq(messages.workspace_id, workspace.id),
                    eq(messages.person_id, personId),
                    inArray(messages.status, [...PENDING_MESSAGE_STATUSES]),
                  ),
                ),
            ),
          ),
        ),
      ),
    );
  return rows.map((row) => row.id);
}

/** Who and what a forget is about, read before anything changes. */
interface ForgetPlan {
  person: Person | null;
  /** The normalized email `lead.forgotten` hashes. */
  email: string | null;
  linkedin: string | null;
  emails: string[];
  redactTargets: RedactionTargets;
  crmLinks: ForgetCrmLink[];
  /** Their replies, so the facts taken from them are deleted too. */
  replyIds: string[];
  toResolve: string[];
}

async function planForget(
  ctx: OpContext,
  target: { person: Person | null; email?: string | null; linkedinUrl?: string | null },
): Promise<ForgetPlan> {
  const person = target.person;
  const email = normalizeEmail(person?.email ?? target.email ?? null);
  const linkedin = normalizePersonLinkedin(person?.linkedin_url ?? target.linkedinUrl ?? null);
  const extraEmail = normalizeEmail(target.email ?? null);
  const emails = [...new Set([email, extraEmail].filter((e): e is string => Boolean(e)))];
  const redactTargets = { emails, linkedinUrls: linkedin ? [linkedin] : [] };
  return {
    person,
    email,
    linkedin,
    emails,
    redactTargets,
    crmLinks: person ? await personCrmLinks(ctx, person.id) : [],
    replyIds: person ? await inboundMessageIds(ctx, person.id) : [],
    toResolve: await problemsToResolve(ctx, person?.id ?? null, redactionPattern(redactTargets)),
  };
}

function startResult(plan: ForgetPlan): ForgetResult {
  return {
    ...emptyScrubCounts(),
    person_id: plan.person?.id ?? null,
    person_deleted: false,
    hashed_suppressions: plan.emails.length + (plan.linkedin ? 1 : 0),
    plain_suppressions_removed: false,
    approvals_cancelled: 0,
    enrollments_stopped: null,
    facts_deleted: 0,
    problems_resolved: plan.toResolve.length,
    redacted: emptyRedactionCounts(),
    crm_links: plan.crmLinks,
  };
}

/** The dry run: what a forget would change, counted without changing anything. */
async function previewForget(ctx: OpContext, plan: ForgetPlan): Promise<ForgetResult> {
  const workspace = requireWorkspace(ctx);
  const { person } = plan;
  const result = startResult(plan);
  let cancelling: string[] = [];
  if (person) {
    Object.assign(result, await scrubPeopleData(ctx, [person.id], false));
    const [open] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.workspace_id, workspace.id),
          eq(enrollments.person_id, person.id),
          inArray(enrollments.status, [...OPEN_ENROLLMENT_STATUSES]),
        ),
      );
    result.enrollments_stopped = open?.n ?? 0;
    result.facts_deleted = await countFacts(ctx, person.id, plan.replyIds);
    cancelling = await approvalsToCancel(ctx, person.id);
  }
  const { problemIds, ...redacted } = await redactStoredCopies(ctx, plan.redactTargets, false, {
    approvalsToCancel: cancelling,
  });
  const named = person ? await eraseNameInProblems(ctx, person, false) : [];
  result.redacted = { ...redacted, problems: new Set([...problemIds, ...named]).size };
  return result;
}

/** Stops the person's enrollments; null when that fails (deleting the person removes them anyway). */
async function stopEnrollmentsForForget(ctx: OpContext, personId: string): Promise<number | null> {
  try {
    // A savepoint, so a failure here does not abort the rest of the forget.
    return await withTransaction(ctx, (inner) =>
      stopEnrollmentsForPerson(inner, { personId, reason: "gdpr_erasure" }),
    );
  } catch (error) {
    ctx.log.warn({ err: error, person_id: personId }, "stopping enrollments for forget failed");
    return null;
  }
}

/** The real run; `forgetLead` runs it in one transaction. */
async function applyForget(ctx: OpContext, plan: ForgetPlan): Promise<ForgetResult> {
  const workspace = requireWorkspace(ctx);
  const { person, emails, linkedin } = plan;
  const result = startResult(plan);
  if (person) {
    result.enrollments_stopped = await stopEnrollmentsForForget(ctx, person.id);
    const pendingMessages = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, workspace.id),
          eq(messages.person_id, person.id),
          inArray(messages.status, [...PENDING_MESSAGE_STATUSES]),
        ),
      );
    result.approvals_cancelled += await ctx.approvals.cancel(
      { target: { type: "person", id: person.id } },
      "gdpr_erasure",
    );
    for (const message of pendingMessages) {
      result.approvals_cancelled += await ctx.approvals.cancel(
        { target: { type: "message", id: message.id } },
        "gdpr_erasure",
      );
    }
  }

  for (const value of emails) {
    await addSuppressionRow(ctx, {
      type: "email",
      value: hashSuppressionValue(value),
      reason: "gdpr_erasure",
      source: "forget",
    });
  }
  if (linkedin) {
    await addSuppressionRow(ctx, {
      type: "linkedin",
      value: hashSuppressionValue(linkedin),
      reason: "gdpr_erasure",
      source: "forget",
    });
  }
  for (const value of emails) {
    await deletePlainSuppressions(ctx.db, workspace.id, { email: value });
  }
  if (linkedin) await deletePlainSuppressions(ctx.db, workspace.id, { linkedin });
  // The person block a privacy request adds would outlive the record it names.
  if (person) await deletePlainSuppressions(ctx.db, workspace.id, { personId: person.id });
  result.plain_suppressions_removed = true;

  if (person) {
    result.facts_deleted = await deleteFactsForPerson(ctx, person.id, {
      messageIds: plan.replyIds,
    });
  }
  let resolved = 0;
  for (const id of plan.toResolve) {
    if ((await resolveProblem(ctx, id, { resolution: "forgotten" })).resolved) resolved += 1;
  }
  // Problems opened for the person while this ran.
  if (person) resolved += await resolveProblemsFor(ctx, { personId: person.id }, "forgotten");
  result.problems_resolved = resolved;

  if (person) Object.assign(result, await scrubPeopleData(ctx, [person.id], true));
  const { problemIds, ...redacted } = await redactStoredCopies(ctx, plan.redactTargets, true);
  const named = person ? await eraseNameInProblems(ctx, person, true) : [];
  result.redacted = { ...redacted, problems: new Set([...problemIds, ...named]).size };

  if (person) {
    const deleted = await ctx.db
      .delete(people)
      .where(and(eq(people.id, person.id), eq(people.workspace_id, workspace.id)))
      .returning({ id: people.id });
    result.person_deleted = deleted.length > 0;
  }
  await ctx.events.emit("lead.forgotten", {
    subject: person ? { type: "person", id: person.id } : null,
    data: {
      person_id: person?.id ?? null,
      email_sha256: plan.email ? emailSha256(plan.email) : null,
      crm_links: plan.crmLinks,
    },
  });
  return result;
}

/**
 * GDPR erasure for a person (by record or by address). Adds `sha256:` suppressions of the
 * normalized email and LinkedIn URL (reason gdpr_erasure), deletes the plain ones, deletes the
 * person's lead-file facts, resolves their problems ("forgotten"), scrubs related data,
 * redacts their address and profile URL in stored copies (events, audit entries, webhook
 * deliveries, problems, finished jobs, decided approvals and finished agent tasks), deletes
 * the person and emits `lead.forgotten`. Works without a record too (suppressions, redaction
 * and the event). The real run is one transaction: a failure anywhere leaves nothing changed,
 * so it can simply run again. With `apply: false` it only counts (the dry run).
 */
export async function forgetLead(
  ctx: OpContext,
  target: { person: Person | null; email?: string | null; linkedinUrl?: string | null },
  apply: boolean,
): Promise<ForgetResult> {
  if (!apply) return previewForget(ctx, await planForget(ctx, target));
  return withTransaction(ctx, async (tx) => applyForget(tx, await planForget(tx, target)));
}
