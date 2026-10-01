/**
 * Signals service: storage, scoring and lookup of buying signals (spec 11.7). Other modules
 * call these binding functions; the signals module's operations and jobs use them too.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import {
  companies,
  people,
  type Signal,
  type SignalDefinition,
  signals,
} from "../../db/schema/index.js";
import type { RawSignal } from "../../providers/types.js";
import { findDefinition, loadDefinitions } from "./catalog.js";
import { buildDedupeKey, clip, requireEvidenceUrl } from "./evidence.js";
import { ageDays, intentScore, normalizeStrength, signalScore } from "./scoring.js";
import { resolveSubject, type SubjectOptions } from "./subjects.js";

/** Every signal definition of a workspace by key, built-in and custom (strategy page). */
export { loadDefinitions } from "./catalog.js";

/** A stored signal with its score decayed to now. */
export type SignalWithScore = Signal & { current_score: number; age_days: number };

const TITLE_MAX = 300;
const SUMMARY_MAX = 1000;
const EXCERPT_MAX = 300;

/** The moment a signal's age is measured from: when it happened, else when we saw it. */
export function signalTime(signal: Pick<Signal, "occurred_at" | "detected_at">): Date {
  return signal.occurred_at ?? signal.detected_at;
}

/**
 * Current decayed score of a stored signal under its definition's current settings. Signals of
 * missing or disabled definitions and dismissed signals score 0.
 */
export function currentScore(
  signal: Pick<Signal, "strength" | "occurred_at" | "detected_at" | "status">,
  definition: SignalDefinition | undefined,
  now: Date,
): number {
  if (!definition?.enabled || signal.status === "dismissed") return 0;
  return signalScore(definition, signal.strength, ageDays(signalTime(signal), now));
}

/** Adds `current_score` and `age_days` (one decimal) to a stored signal. */
export function withScore(
  signal: Signal,
  definitions: Map<string, SignalDefinition>,
  now: Date,
): SignalWithScore {
  return {
    ...signal,
    current_score: currentScore(signal, definitions.get(signal.definition_key), now),
    age_days: Math.round(ageDays(signalTime(signal), now) * 10) / 10,
  };
}

/**
 * Active (not dismissed) signals, highest current score first.
 *
 * - `personId`: the person's own signals plus company-level signals (no person) of
 *   `companyId` or, when omitted, of the person's company. Other people's signals are excluded.
 * - `companyId` only: every signal at the company, including its people's.
 * - neither: the workspace's strongest signals.
 * `minScore` defaults to 1 (decayed to nothing = inactive); `limit` defaults to 10 (max 100).
 */
export async function getActiveSignals(
  ctx: OpContext,
  input: { companyId?: string; personId?: string; minScore?: number; limit?: number },
): Promise<SignalWithScore[]> {
  const workspace = requireWorkspace(ctx);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const minScore = input.minScore ?? 1;
  const conditions: SQL[] = [
    eq(signals.workspace_id, workspace.id),
    ne(signals.status, "dismissed"),
  ];
  if (input.personId) {
    let companyId = input.companyId ?? null;
    if (!companyId) {
      const [person] = await ctx.db
        .select({ company_id: people.company_id })
        .from(people)
        .where(and(eq(people.workspace_id, workspace.id), eq(people.id, input.personId)));
      companyId = person?.company_id ?? null;
    }
    const own = eq(signals.person_id, input.personId);
    const subject = companyId
      ? or(own, and(eq(signals.company_id, companyId), isNull(signals.person_id)))
      : own;
    if (subject) conditions.push(subject);
  } else if (input.companyId) {
    conditions.push(eq(signals.company_id, input.companyId));
  }
  const rows = await ctx.db
    .select()
    .from(signals)
    .where(and(...conditions))
    .orderBy(desc(signals.detected_at), desc(signals.id))
    .limit(input.personId || input.companyId ? 500 : 2000);
  if (rows.length === 0) return [];
  const definitions = await loadDefinitions(ctx.db, workspace.id);
  const now = ctx.clock.now();
  return rows
    .map((row) => withScore(row, definitions, now))
    .filter((row) => row.current_score >= minScore && row.current_score > 0)
    .sort(
      (a, b) =>
        b.current_score - a.current_score ||
        b.detected_at.getTime() - a.detected_at.getTime() ||
        (a.id < b.id ? 1 : -1),
    )
    .slice(0, limit);
}

/** What storeSignal did. */
export interface StoreSignalResult {
  id: string;
  created: boolean;
  /** Score at detection (0 below min_strength or when fully decayed). */
  score: number;
  /** True when `signal.detected` was emitted (new signal with score >= 1). */
  emitted: boolean;
  companyId: string | null;
  personId: string | null;
  createdCompany: boolean;
}

export type RecordSignalInput = RawSignal & { companyId?: string; personId?: string };

/**
 * Validates, dedupes, scores and stores one signal, emits `signal.detected` for new scored
 * signals and refreshes the company intent score. Throws `validation_failed` for a missing
 * evidence URL, an unknown or disabled definition, or an unknown subject.
 */
export async function storeSignal(
  ctx: OpContext,
  input: RecordSignalInput,
  options: SubjectOptions = {},
): Promise<StoreSignalResult> {
  const workspace = requireWorkspace(ctx);
  const key = (input.definition_key ?? "").trim();
  const definition = key ? await findDefinition(ctx.db, workspace.id, key) : null;
  if (!definition) {
    throw new OpenOutboundError("validation_failed", `Unknown signal key "${key}".`, {
      hint: "List keys with manage_signals action list_definitions, or create one with action define_custom.",
      details: { field: "definition_key", key },
    });
  }
  if (!definition.enabled) {
    throw new OpenOutboundError("validation_failed", `Signal definition "${key}" is disabled.`, {
      hint: `Enable it with manage_signals action update_definition (key "${key}", enabled true).`,
      details: { field: "definition_key", key, reason: "definition_disabled" },
    });
  }
  const evidenceUrl = requireEvidenceUrl(input.evidence_url);
  const title = clip(input.title, TITLE_MAX);
  if (!title) {
    throw new OpenOutboundError("validation_failed", "A signal needs a title.", {
      hint: "Pass a one-line title, e.g. 'Raised a $12M Series A'.",
      details: { field: "title" },
    });
  }
  const subject = await resolveSubject(
    ctx,
    workspace.id,
    {
      companyId: input.companyId,
      personId: input.personId,
      company: input.company,
      person: input.person,
    },
    options,
  );
  const companyId = subject.company?.id ?? null;
  const personId = subject.person?.id ?? null;

  const now = ctx.clock.now();
  let occurredAt = input.occurred_at ? new Date(input.occurred_at) : null;
  if (occurredAt && Number.isNaN(occurredAt.getTime())) occurredAt = null;
  // Future dates are clock skew or typos: count them as now.
  if (occurredAt && occurredAt.getTime() > now.getTime()) occurredAt = now;
  const strength = normalizeStrength(input.strength);
  const score = signalScore(definition, strength, ageDays(occurredAt ?? now, now));
  const dedupeKey = buildDedupeKey({
    definitionKey: definition.key,
    companyId,
    personId,
    evidenceUrl,
    provided: input.dedupe_key,
  });

  const [inserted] = await ctx.db
    .insert(signals)
    .values({
      workspace_id: workspace.id,
      definition_key: definition.key,
      company_id: companyId,
      person_id: personId,
      title,
      summary: clip(input.summary, SUMMARY_MAX),
      evidence_url: evidenceUrl,
      evidence_excerpt: clip(input.evidence_excerpt, EXCERPT_MAX),
      source: clip(input.source, 100) ?? "unknown",
      occurred_at: occurredAt,
      detected_at: now,
      strength,
      score,
      status: "new",
      dedupe_key: dedupeKey,
      raw: input.raw ?? null,
    })
    .onConflictDoNothing({ target: [signals.workspace_id, signals.dedupe_key] })
    .returning({ id: signals.id });

  if (!inserted) {
    const [existing] = await ctx.db
      .select({ id: signals.id, score: signals.score })
      .from(signals)
      .where(and(eq(signals.workspace_id, workspace.id), eq(signals.dedupe_key, dedupeKey)));
    if (!existing) throw new Error(`Signal ${dedupeKey} vanished during insert`);
    return {
      id: existing.id,
      created: false,
      score: existing.score,
      emitted: false,
      companyId,
      personId,
      createdCompany: subject.createdCompany,
    };
  }

  let emitted = false;
  if (score >= 1) {
    await ctx.events.emit("signal.detected", {
      workspaceId: workspace.id,
      subject: personId
        ? { type: "person", id: personId }
        : companyId
          ? { type: "company", id: companyId }
          : null,
      data: {
        signal_id: inserted.id,
        definition_key: definition.key,
        company_id: companyId,
        person_id: personId,
        title,
        evidence_url: evidenceUrl,
        strength,
        score,
      },
    });
    emitted = true;
  }
  if (companyId) await recomputeCompanyIntent(ctx, workspace.id, companyId);
  return {
    id: inserted.id,
    created: true,
    score,
    emitted,
    companyId,
    personId,
    createdCompany: subject.createdCompany,
  };
}

/** Dedupes, scores and stores a signal; emits signal.detected when it is new. */
export async function recordSignal(
  ctx: OpContext,
  input: RawSignal & { companyId?: string; personId?: string },
  options?: SubjectOptions,
): Promise<{ id: string; created: boolean }> {
  const result = await storeSignal(ctx, input, options);
  return { id: result.id, created: result.created };
}

/**
 * Marks signals as used in outreach (for attribution in reports): status `used` (dismissed
 * signals keep their status), `used_at` set once, and the message id appended to
 * `used_message_ids`. Ids outside the workspace are ignored.
 */
export async function markSignalsUsed(
  ctx: OpContext,
  signalIds: string[],
  options?: { messageId?: string },
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const ids = [...new Set(signalIds.filter(Boolean))];
  if (ids.length === 0) return;
  const rows = await ctx.db
    .select({
      id: signals.id,
      status: signals.status,
      used_at: signals.used_at,
      used_message_ids: signals.used_message_ids,
    })
    .from(signals)
    .where(and(eq(signals.workspace_id, workspace.id), inArray(signals.id, ids)));
  const now = ctx.clock.now();
  const messageId = options?.messageId;
  for (const row of rows) {
    const messageIds =
      messageId && !row.used_message_ids.includes(messageId)
        ? [...row.used_message_ids, messageId]
        : row.used_message_ids;
    await ctx.db
      .update(signals)
      .set({
        status: row.status === "dismissed" ? "dismissed" : "used",
        used_at: row.used_at ?? now,
        used_message_ids: messageIds,
      })
      .where(eq(signals.id, row.id));
  }
}

/** Recomputes and stores `companies.intent_score` from the company's active signals. */
export async function recomputeCompanyIntent(
  ctx: OpContext,
  workspaceId: string,
  companyId: string,
): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.workspace_id, workspaceId),
        eq(signals.company_id, companyId),
        ne(signals.status, "dismissed"),
      ),
    );
  const definitions = await loadDefinitions(ctx.db, workspaceId);
  const now = ctx.clock.now();
  const intent = intentScore(
    rows.map((row) => ({
      definition_key: row.definition_key,
      score: currentScore(row, definitions.get(row.definition_key), now),
    })),
  );
  await ctx.db
    .update(companies)
    .set({ intent_score: intent })
    .where(and(eq(companies.workspace_id, workspaceId), eq(companies.id, companyId)));
  return intent;
}

/**
 * Recomputes intent for every company of the workspace that has signals or a stored intent
 * score (nightly decay, definition changes). Returns how many companies changed.
 */
export async function recomputeWorkspaceIntent(
  ctx: OpContext,
  workspaceId: string,
): Promise<{ companies: number; changed: number }> {
  const definitions = await loadDefinitions(ctx.db, workspaceId);
  const now = ctx.clock.now();
  const withSignals = await ctx.db
    .selectDistinct({ id: signals.company_id })
    .from(signals)
    .where(and(eq(signals.workspace_id, workspaceId), isNotNull(signals.company_id)));
  const withIntent = await ctx.db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.workspace_id, workspaceId), isNotNull(companies.intent_score)));
  const ids = [
    ...new Set([...withSignals, ...withIntent].map((row) => row.id).filter(Boolean)),
  ] as string[];
  let changed = 0;
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    const rows = await ctx.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.workspace_id, workspaceId),
          inArray(signals.company_id, chunk),
          ne(signals.status, "dismissed"),
        ),
      );
    const current = await ctx.db
      .select({ id: companies.id, intent_score: companies.intent_score })
      .from(companies)
      .where(and(eq(companies.workspace_id, workspaceId), inArray(companies.id, chunk)));
    for (const company of current) {
      const intent = intentScore(
        rows
          .filter((row) => row.company_id === company.id)
          .map((row) => ({
            definition_key: row.definition_key,
            score: currentScore(row, definitions.get(row.definition_key), now),
          })),
      );
      if (intent === company.intent_score) continue;
      await ctx.db
        .update(companies)
        .set({ intent_score: intent })
        .where(eq(companies.id, company.id));
      changed += 1;
    }
  }
  return { companies: ids.length, changed };
}
