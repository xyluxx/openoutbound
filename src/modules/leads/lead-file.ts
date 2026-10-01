/**
 * The lead file in reads: fact, note and promise views for get_lead and companies.get, what
 * each person at a company is doing, and the plain words the timeline and the writer context
 * share. Facts are prospect-derived text: outputs that carry them are marked untrusted.
 */
import { and, desc, eq, gt, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import {
  ENROLLMENT_STATUSES,
  FACT_KINDS,
  FACT_SCOPES,
  FACT_SOURCES,
  FACT_STATUSES,
  type FactKind,
  type FactSource,
  REPLY_CATEGORIES,
  type ReplyCategory,
} from "../../core/enums.js";
import { isoDateTime } from "../../core/operation.js";
import {
  campaigns,
  enrollments,
  lead_facts,
  messages,
  type Person,
  tasks,
} from "../../db/schema/index.js";
import { effectiveFact, type LeadFact } from "./facts.js";

// --- Shapes ----------------------------------------------------------------------------------

export const factView = z.object({
  id: z.string(),
  scope: z.enum(FACT_SCOPES).describe("person = about this person; company = about the company"),
  kind: z.enum(FACT_KINDS),
  text: z.string(),
  source: z.enum(FACT_SOURCES),
  source_ref: z.string().nullable().describe("Message id for replies, CRM name for crm"),
  status: z.enum(FACT_STATUSES),
  observed_at: isoDateTime(),
  expires_at: isoDateTime().nullable(),
  person_id: z.string().nullable(),
  company_id: z.string().nullable(),
  replaced_by: z.string().nullable().describe("The fact that corrected this one"),
});
export type FactView = z.input<typeof factView>;

export const promiseView = z.object({
  task_id: z.string(),
  title: z.string(),
  due_at: isoDateTime().nullable(),
  overdue: z.boolean(),
  thread_id: z.string().nullable(),
  created_at: isoDateTime(),
});

export const personStateView = z.object({
  campaign: z
    .object({ name: z.string().nullable(), status: z.enum(ENROLLMENT_STATUSES) })
    .nullable()
    .describe("The campaign the person is in now, or null"),
  last_contacted_at: isoDateTime().nullable(),
  last_reply: z
    .object({ category: z.enum(REPLY_CATEGORIES).nullable(), at: isoDateTime() })
    .nullable(),
});

export function toFactView(row: LeadFact): FactView {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    text: row.text,
    source: row.source,
    source_ref: row.source_ref,
    status: row.status,
    observed_at: row.observed_at,
    expires_at: row.expires_at,
    person_id: row.person_id,
    company_id: row.company_id,
    replaced_by: row.replaced_by,
  };
}

// --- Reads -----------------------------------------------------------------------------------

/**
 * Active facts (not expired) about a person and/or a company, newest observed first. `notes`
 * picks kind `note` only; otherwise notes are left out.
 */
export async function activeFacts(
  ctx: OpContext,
  target: { personId?: string | null; companyId?: string | null },
  options: { notes: boolean; limit: number },
): Promise<LeadFact[]> {
  const workspace = requireWorkspace(ctx);
  const targets: Array<SQL | undefined> = [];
  if (target.personId) {
    targets.push(and(eq(lead_facts.scope, "person"), eq(lead_facts.person_id, target.personId)));
  }
  if (target.companyId) {
    targets.push(and(eq(lead_facts.scope, "company"), eq(lead_facts.company_id, target.companyId)));
  }
  if (targets.length === 0) return [];
  const now = ctx.clock.now();
  const rows = await ctx.db
    .select()
    .from(lead_facts)
    .where(
      and(
        eq(lead_facts.workspace_id, workspace.id),
        or(...targets),
        eq(lead_facts.status, "active"),
        or(isNull(lead_facts.expires_at), gt(lead_facts.expires_at, now)),
        options.notes ? eq(lead_facts.kind, "note") : ne(lead_facts.kind, "note"),
      ),
    )
    .orderBy(desc(lead_facts.observed_at), desc(lead_facts.created_at), desc(lead_facts.id))
    .limit(options.limit);
  return rows.map((row) => effectiveFact(row, now));
}

/** Open promise tasks of a person (what we said we would do), soonest due first. */
export async function openPromises(ctx: OpContext, personId: string, limit = 20) {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const rows = await ctx.db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspace_id, workspace.id),
        eq(tasks.person_id, personId),
        eq(tasks.type, "promise"),
        eq(tasks.status, "open"),
      ),
    )
    .orderBy(sql`${tasks.due_at} asc nulls last`, tasks.created_at)
    .limit(limit);
  return rows.map((task) => ({
    task_id: task.id,
    title: task.title,
    due_at: task.due_at,
    overdue: task.due_at !== null && task.due_at.getTime() < now.getTime(),
    thread_id: task.thread_id,
    created_at: task.created_at,
  }));
}

/** What each person is doing: the campaign they are in, the last contact and the last reply. */
export async function peopleStates(
  ctx: OpContext,
  people: Array<Pick<Person, "id" | "last_contacted_at">>,
): Promise<Map<string, z.input<typeof personStateView>>> {
  const workspace = requireWorkspace(ctx);
  const ids = people.map((person) => person.id);
  const states = new Map<string, z.input<typeof personStateView>>();
  if (ids.length === 0) return states;
  const current = await ctx.db
    .selectDistinctOn([enrollments.person_id], {
      person_id: enrollments.person_id,
      status: enrollments.status,
      name: campaigns.name,
    })
    .from(enrollments)
    .leftJoin(campaigns, eq(campaigns.id, enrollments.campaign_id))
    .where(
      and(
        eq(enrollments.workspace_id, workspace.id),
        inArray(enrollments.person_id, ids),
        inArray(enrollments.status, ["queued", "active", "paused", "waiting_review"]),
      ),
    )
    .orderBy(enrollments.person_id, desc(enrollments.enrolled_at));
  const replies = await ctx.db
    .selectDistinctOn([messages.person_id], {
      person_id: messages.person_id,
      category: sql<ReplyCategory | null>`${messages.classification}->>'category'`,
      at: sql<Date>`coalesce(${messages.received_at}, ${messages.created_at})`.mapWith(
        (value: string | Date) => new Date(value),
      ),
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        inArray(messages.person_id, ids),
        eq(messages.direction, "inbound"),
      ),
    )
    .orderBy(
      messages.person_id,
      desc(sql`coalesce(${messages.received_at}, ${messages.created_at})`),
    );
  const campaignOf = new Map(current.map((row) => [row.person_id, row]));
  const replyOf = new Map(replies.map((row) => [row.person_id, row]));
  for (const person of people) {
    const enrollment = campaignOf.get(person.id);
    const reply = replyOf.get(person.id);
    states.set(person.id, {
      campaign: enrollment ? { name: enrollment.name, status: enrollment.status } : null,
      last_contacted_at: person.last_contacted_at,
      last_reply: reply
        ? {
            category: (REPLY_CATEGORIES as readonly string[]).includes(reply.category ?? "")
              ? reply.category
              : null,
            at: reply.at,
          }
        : null,
    });
  }
  return states;
}

// --- Plain words -----------------------------------------------------------------------------

/** Reply categories in words ("Replied: not now"). */
export const CATEGORY_WORDS: Record<ReplyCategory, string> = {
  interested: "interested",
  meeting_request: "wants a meeting",
  question: "asked a question",
  objection: "objection",
  not_now: "not now",
  referral: "pointed to someone else",
  wrong_person: "wrong person",
  out_of_office: "out of office",
  unsubscribe: "asked to stop",
  privacy_request: "privacy request",
  bounce: "bounce",
  negative: "negative",
  auto_reply_other: "automatic reply",
  other: "other",
};

export const FACT_KIND_LABELS: Record<FactKind, string> = {
  fact: "Fact",
  timing: "Timing",
  preference: "Preference",
  objection: "Objection",
  relationship: "Relationship",
  note: "Note",
};

export const FACT_SOURCE_WORDS: Record<FactSource, string> = {
  reply: "from a reply",
  manual: "added by a person",
  agent: "added by an agent",
  crm: "from the CRM",
  research: "from research",
};

const STOP_REASON_WORDS: Record<string, string> = {
  replied: "they replied",
  company_replied: "a colleague replied",
  meeting_booked: "a meeting was booked",
  company_meeting_booked: "a colleague booked a meeting",
  unsubscribed: "they asked to stop",
  bounced: "the email bounced",
  gdpr_erasure: "their data was erased",
  missing_data: "data was missing",
  manual: "stopped by hand",
  not_contactable: "they could not be contacted",
  person_removed: "the lead was deleted",
  negative: "they replied negatively",
  not_interested: "they were not interested",
  wrong_person: "wrong person",
  left_company: "they left the company",
};

/** An enrollment stop reason in words ("they replied"). */
export function stopReasonWords(reason: string | null | undefined): string {
  if (!reason) return "no reason recorded";
  return STOP_REASON_WORDS[reason] ?? reason.replace(/[_:]+/g, " ").trim();
}

function formatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone });
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
  }
}

/** "8 Oct 2026" in the zone. */
export function formatDay(date: Date, zone: string): string {
  return formatter(zone, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

/** "8 Oct, 15:00" in the zone (the year is added when it is not the year of `now`). */
export function formatMoment(date: Date, zone: string, now: Date): string {
  const sameYear =
    formatter(zone, { year: "numeric" }).format(date) ===
    formatter(zone, { year: "numeric" }).format(now);
  return formatter(zone, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
