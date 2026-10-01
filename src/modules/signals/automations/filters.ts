/** Whether a rule applies to a signal, and which people its actions act on. */
import { and, asc, eq, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import {
  type Company,
  list_members,
  type Person,
  people,
  type Signal,
} from "../../../db/schema/index.js";
import type { AutomationFilters } from "./schema.js";

/** People automations never act on. */
const BLOCKED_STATUSES = ["do_not_contact", "unsubscribed", "bounced"] as const;
const CANDIDATE_LIMIT = 200;

export interface AutomationSubject {
  signal: Signal;
  company: Company | null;
  person: Person | null;
}

export interface FilterCheck {
  ok: boolean;
  reason?: string;
}

/** Filters that only need the signal and its company or person. */
export function checkSignalFilters(
  filters: AutomationFilters,
  subject: AutomationSubject,
): FilterCheck {
  const { signal } = subject;
  const keys = filters.definition_keys ?? [];
  if (keys.length > 0 && !keys.includes(signal.definition_key)) {
    return { ok: false, reason: `signal key ${signal.definition_key} is not in definition_keys` };
  }
  if (filters.min_score !== undefined && signal.score < filters.min_score) {
    return { ok: false, reason: `score ${signal.score} is below min_score ${filters.min_score}` };
  }
  if (filters.min_fit !== undefined) {
    const fit = subject.company?.fit_score ?? subject.person?.fit_score ?? null;
    if (fit === null || fit < filters.min_fit) {
      return {
        ok: false,
        reason: `fit_score ${fit ?? "unknown"} is below min_fit ${filters.min_fit}`,
      };
    }
  }
  return { ok: true };
}

/**
 * People the rule's actions act on: the signal's own person, else the company's people (best
 * fit first), minus blocked statuses, narrowed by `has_email` and `list_id`.
 */
export async function candidatePeople(
  ctx: OpContext,
  subject: AutomationSubject,
  filters: AutomationFilters,
): Promise<Person[]> {
  const workspaceId = subject.signal.workspace_id;
  let candidates: Person[];
  if (subject.person) {
    candidates = (BLOCKED_STATUSES as readonly string[]).includes(subject.person.status)
      ? []
      : [subject.person];
  } else if (subject.company) {
    const conditions = [
      eq(people.workspace_id, workspaceId),
      eq(people.company_id, subject.company.id),
      notInArray(people.status, [...BLOCKED_STATUSES]),
    ];
    if (filters.has_email) {
      const withEmail = isNotNull(people.email);
      conditions.push(withEmail, ne(people.email_status, "invalid"));
    }
    candidates = await ctx.db
      .select()
      .from(people)
      .where(and(...conditions))
      .orderBy(sql`${people.fit_score} desc nulls last`, asc(people.id))
      .limit(CANDIDATE_LIMIT);
  } else {
    candidates = [];
  }
  if (filters.has_email) {
    candidates = candidates.filter(
      (person) => Boolean(person.email) && person.email_status !== "invalid",
    );
  }
  if (filters.list_id && candidates.length > 0) {
    const members = await ctx.db
      .select({ person_id: list_members.person_id })
      .from(list_members)
      .where(
        and(
          eq(list_members.list_id, filters.list_id),
          inArray(
            list_members.person_id,
            candidates.map((person) => person.id),
          ),
        ),
      );
    const ids = new Set(members.map((member) => member.person_id));
    candidates = candidates.filter((person) => ids.has(person.id));
  }
  return candidates;
}

/** Full check: signal filters, then the people filters (list, email) when they are set. */
export async function evaluateRuleFilters(
  ctx: OpContext,
  filters: AutomationFilters,
  subject: AutomationSubject,
): Promise<FilterCheck & { people: Person[] }> {
  const basic = checkSignalFilters(filters, subject);
  if (!basic.ok) return { ...basic, people: [] };
  const matched = await candidatePeople(ctx, subject, filters);
  if ((filters.list_id || filters.has_email) && matched.length === 0) {
    const wanted = [
      filters.list_id ? `in list ${filters.list_id}` : null,
      filters.has_email ? "with a usable email" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return { ok: false, reason: `no person ${wanted}`, people: [] };
  }
  return { ok: true, people: matched };
}
