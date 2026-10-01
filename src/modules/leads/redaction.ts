/**
 * Redaction for `forget`: a forgotten person's email address and LinkedIn profile URL are
 * replaced with "[erased]" in the stored copies that keep no link to the person record: events
 * (webhook payloads are built from them at delivery), audit entries, webhook delivery errors,
 * problems, finished jobs, decided approvals and finished agent tasks. Matches are exact (the
 * whole address or profile URL, any letter case), and every query is scoped to the workspace.
 * The person's own problems also lose their name.
 *
 * JSON columns are redacted value by value, never as JSON text: rows are picked with a loose
 * filter (the address or the profile slug as a substring, any case), then every string of the
 * value (keys too) gets the precise pattern, so an escape in the JSON text (a line break is
 * `\n` there) can neither hide an address nor break the JSON. Plain text columns get the same
 * pattern. Only rows that change are written, and a dry run counts exactly those.
 */
import { and, asc, eq, gt, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import {
  agent_tasks,
  approvals,
  audit_events,
  events,
  jobs,
  problems,
  webhook_deliveries,
  webhook_endpoints,
} from "../../db/schema/index.js";

export const ERASED = "[erased]";

export interface RedactionTargets {
  /** Normalized email addresses. */
  emails: string[];
  /** Normalized LinkedIn profile URLs (https://www.linkedin.com/in/<slug>). */
  linkedinUrls: string[];
}

export interface RedactionCounts {
  events: number;
  audit_entries: number;
  webhook_deliveries: number;
  problems: number;
  jobs: number;
  approvals: number;
  agent_tasks: number;
}

export function emptyRedactionCounts(): RedactionCounts {
  return {
    events: 0,
    audit_entries: 0,
    webhook_deliveries: 0,
    problems: 0,
    jobs: 0,
    approvals: 0,
    agent_tasks: 0,
  };
}

/** Escapes regular expression metacharacters (the same set in Postgres and JavaScript). */
function escapeRegex(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/**
 * The characters an address or a host name is made of. A match never starts right after one
 * of them, so every other character (a space, a line break, a quote, a bracket, a slash) is a
 * boundary.
 */
const NOT_AFTER_ADDRESS = "(?<![a-z0-9._%+-])";

/** The whole address, not part of a longer one ("ana@x.example" never matches in "dana@x.example"). */
export function emailPattern(email: string): string {
  return `${NOT_AFTER_ADDRESS}${escapeRegex(email)}(?![a-z0-9-]|\\.[a-z0-9])`;
}

const PROFILE_PREFIX = "https://www.linkedin.com/in/";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The profile slug as stored and decoded ("jos%C3%A9-diaz" and "josé-diaz"); none for other URLs. */
function profileSlugs(url: string): string[] {
  if (!url.startsWith(PROFILE_PREFIX)) return [];
  const slug = url.slice(PROFILE_PREFIX.length).replace(/\/+$/, "");
  return slug ? [...new Set([slug, safeDecode(slug)])] : [];
}

/**
 * The profile URL with or without scheme or subdomain, the slug encoded or not, and nothing
 * longer: not a longer slug, and not the end of a longer host ("notlinkedin.com/in/...").
 */
export function linkedinPattern(url: string): string | null {
  const slugs = profileSlugs(url).map(escapeRegex);
  if (slugs.length === 0) return null;
  return `${NOT_AFTER_ADDRESS}(?:https?://)?(?:[a-z0-9-]+\\.)*linkedin\\.com/in/(?:${slugs.join("|")})(?![a-z0-9_%-])`;
}

/** One case-insensitive pattern for all targets, or null when there is nothing to redact. */
export function redactionPattern(targets: RedactionTargets): string | null {
  const parts = [
    ...[...new Set(targets.emails)].filter(Boolean).map(emailPattern),
    ...[...new Set(targets.linkedinUrls)]
      .map(linkedinPattern)
      .filter((part): part is string => part !== null),
  ];
  return parts.length > 0 ? `(?:${parts.join("|")})` : null;
}

/**
 * Lowercase text that every mention of the targets contains (the address, the profile slug):
 * the loose first filter for JSON columns, before the pattern checks value by value.
 */
export function redactionTerms(targets: RedactionTargets): string[] {
  const terms = [
    ...targets.emails.filter(Boolean),
    ...targets.linkedinUrls.flatMap(profileSlugs),
  ].map((term) => term.toLowerCase());
  return [...new Set(terms)];
}

/**
 * Replaces the pattern (a global regular expression) in every string of a JSON value, object
 * keys included. Returns the same value when nothing matched, so callers can compare.
 */
export function redactJson(value: unknown, pattern: RegExp): unknown {
  if (typeof value === "string") return value.replace(pattern, ERASED);
  if (Array.isArray(value)) {
    const next = value.map((item) => redactJson(item, pattern));
    return next.some((item, index) => item !== value[index]) ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
      const nextKey = key.replace(pattern, ERASED);
      const nextValue = redactJson(inner, pattern);
      if (nextKey !== key || nextValue !== inner) changed = true;
      return [nextKey, nextValue] as const;
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

const FINISHED_JOB_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const FINISHED_TASK_STATUSES = ["done", "failed", "expired"] as const;
/** Candidate rows read per query. */
const PAGE = 200;

/** One table with stored copies: the rows in scope and the columns that may hold the targets. */
interface CopyTable {
  table: PgTable;
  id: AnyPgColumn;
  /** The workspace, and the statuses whose rows may change. */
  scope: SQL;
  /** Plain text columns by field name. */
  text: Record<string, AnyPgColumn>;
  /** jsonb columns by field name. */
  json: Record<string, AnyPgColumn>;
}

type CopyRow = Record<string, unknown> & { id: string };

/**
 * Redacts one table (with `apply: false`, only finds what would change) and returns the ids of
 * the rows that change. Candidates come from the pattern on text columns and the loose terms
 * on JSON columns; the pattern then decides, value by value.
 */
async function redactTable(
  ctx: OpContext,
  spec: CopyTable,
  pattern: string,
  terms: string[],
  apply: boolean,
): Promise<string[]> {
  const regex = new RegExp(pattern, "gi");
  const candidates = or(
    ...Object.values(spec.text).map((column) => sql`${column} ~* ${pattern}`),
    ...Object.values(spec.json).flatMap((column) =>
      terms.map((term) => sql`strpos(lower(${column}::text), ${term}) > 0`),
    ),
  );
  const fields: Record<string, AnyPgColumn> = { id: spec.id, ...spec.text, ...spec.json };
  const changed: string[] = [];
  let after: string | null = null;
  for (;;) {
    const rows = (await ctx.db
      .select(fields)
      .from(spec.table)
      .where(and(spec.scope, candidates, after === null ? undefined : gt(spec.id, after)))
      .orderBy(asc(spec.id))
      .limit(PAGE)) as CopyRow[];
    for (const row of rows) {
      const patch: Record<string, unknown> = {};
      for (const name of Object.keys(spec.text)) {
        const before = row[name];
        if (typeof before !== "string") continue;
        const next = before.replace(regex, ERASED);
        if (next !== before) patch[name] = next;
      }
      for (const name of Object.keys(spec.json)) {
        const before = row[name];
        const next = redactJson(before, regex);
        if (next !== before) patch[name] = next;
      }
      if (Object.keys(patch).length === 0) continue;
      changed.push(row.id);
      if (apply) {
        await ctx.db
          .update(spec.table)
          .set(patch)
          .where(and(spec.scope, eq(spec.id, row.id)));
      }
    }
    const last = rows.at(-1);
    if (rows.length < PAGE || !last) break;
    after = last.id;
  }
  return changed;
}

/**
 * Redacts (or with `apply: false` counts) the targets' email addresses and LinkedIn URLs in
 * stored copies. Jobs that may still run, pending approvals and open agent tasks are left
 * alone so work in flight keeps its input. `approvalsToCancel` names pending approvals the
 * caller cancels before it redacts, so a dry run counts them as the real run will.
 */
export async function redactStoredCopies(
  ctx: OpContext,
  targets: RedactionTargets,
  apply: boolean,
  options: { approvalsToCancel?: string[] } = {},
): Promise<RedactionCounts & { problemIds: string[] }> {
  const workspace = requireWorkspace(ctx);
  const pattern = redactionPattern(targets);
  if (!pattern) return { ...emptyRedactionCounts(), problemIds: [] };
  const terms = redactionTerms(targets);
  const run = async (spec: CopyTable) => redactTable(ctx, spec, pattern, terms, apply);
  const cancelling = options.approvalsToCancel ?? [];
  const inWorkspace = <T extends AnyPgColumn>(column: T) => eq(column, workspace.id);

  const eventIds = await run({
    table: events,
    id: events.id,
    scope: inWorkspace(events.workspace_id),
    text: {},
    json: { data: events.data },
  });
  const auditIds = await run({
    table: audit_events,
    id: audit_events.id,
    scope: inWorkspace(audit_events.workspace_id),
    text: { reason: audit_events.reason, summary: audit_events.summary },
    json: { input: audit_events.input },
  });
  const deliveryIds = await run({
    table: webhook_deliveries,
    id: webhook_deliveries.id,
    scope: inArray(
      webhook_deliveries.endpoint_id,
      ctx.db
        .select({ id: webhook_endpoints.id })
        .from(webhook_endpoints)
        .where(eq(webhook_endpoints.workspace_id, workspace.id)),
    ),
    text: { last_error: webhook_deliveries.last_error },
    json: {},
  });
  const problemIds = await run({
    table: problems,
    id: problems.id,
    scope: inWorkspace(problems.workspace_id),
    text: { title: problems.title, reason: problems.reason, remedy: problems.remedy },
    json: { data: problems.data },
  });
  const jobIds = await run({
    table: jobs,
    id: jobs.id,
    scope: and(
      inWorkspace(jobs.workspace_id),
      inArray(jobs.status, [...FINISHED_JOB_STATUSES]),
    ) as SQL,
    text: { last_error: jobs.last_error },
    json: { payload: jobs.payload, result: jobs.result },
  });
  const approvalIds = await run({
    table: approvals,
    id: approvals.id,
    scope: and(
      inWorkspace(approvals.workspace_id),
      cancelling.length > 0
        ? or(ne(approvals.status, "pending"), inArray(approvals.id, cancelling))
        : ne(approvals.status, "pending"),
    ) as SQL,
    text: {
      title: approvals.title,
      summary: approvals.summary,
      decision_note: approvals.decision_note,
    },
    json: { payload: approvals.payload },
  });
  const taskIds = await run({
    table: agent_tasks,
    id: agent_tasks.id,
    scope: and(
      inWorkspace(agent_tasks.workspace_id),
      inArray(agent_tasks.status, [...FINISHED_TASK_STATUSES]),
    ) as SQL,
    text: { instructions: agent_tasks.instructions },
    json: { input: agent_tasks.input, output: agent_tasks.output },
  });
  return {
    events: eventIds.length,
    audit_entries: auditIds.length,
    webhook_deliveries: deliveryIds.length,
    problems: problemIds.length,
    jobs: jobIds.length,
    approvals: approvalIds.length,
    agent_tasks: taskIds.length,
    problemIds,
  };
}

type Replacement = readonly [from: string, to: string];

/** Applies exact (case-sensitive) replacements to a string, or to the strings of a JSON value. */
function replaceExact(value: unknown, pairs: Replacement[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const [from, to] of pairs) text = text.split(from).join(to);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => replaceExact(item, pairs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        replaceExact(inner, pairs),
      ]),
    );
  }
  return value;
}

/** The person's full name, and their first name in a greeting ("Hi Dana,"). */
function nameReplacements(person: {
  full_name: string | null;
  first_name: string | null;
}): Replacement[] {
  const full = person.full_name?.trim() ?? "";
  const first = person.first_name?.trim() ?? "";
  const pairs: Replacement[] = [];
  if (full.length >= 2) pairs.push([full, ERASED]);
  if (first.length >= 2) {
    for (const greeting of ["Hi", "Hello", "Dear"]) {
      pairs.push([`${greeting} ${first},`, `${greeting} ${ERASED},`]);
    }
  }
  return pairs;
}

/**
 * Removes the person's name from their own problems (title, reason, remedy and data): the
 * full name, and the first name in a greeting such as "Hi Dana,". Returns the ids of the
 * problems that changed (with `apply: false`, that would change).
 */
export async function eraseNameInProblems(
  ctx: OpContext,
  person: { id: string; full_name: string | null; first_name: string | null },
  apply: boolean,
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const pairs = nameReplacements(person);
  if (pairs.length === 0) return [];
  const rows = await ctx.db
    .select({
      id: problems.id,
      title: problems.title,
      reason: problems.reason,
      remedy: problems.remedy,
      data: problems.data,
    })
    .from(problems)
    .where(and(eq(problems.workspace_id, workspace.id), eq(problems.person_id, person.id)));
  const changed: string[] = [];
  for (const row of rows) {
    const next = {
      title: replaceExact(row.title, pairs) as string,
      reason: replaceExact(row.reason, pairs) as string,
      remedy: replaceExact(row.remedy, pairs) as string,
      data: replaceExact(row.data, pairs) as Record<string, unknown>,
    };
    const same =
      next.title === row.title &&
      next.reason === row.reason &&
      next.remedy === row.remedy &&
      JSON.stringify(next.data) === JSON.stringify(row.data);
    if (same) continue;
    changed.push(row.id);
    if (apply) {
      await ctx.db
        .update(problems)
        .set(next)
        .where(and(eq(problems.workspace_id, workspace.id), eq(problems.id, row.id)));
    }
  }
  return changed;
}
