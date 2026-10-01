/**
 * The lead file's facts: short business facts about a person or a whole company, learned from
 * replies, written by people and agents, or read from a CRM or research. Only active facts reach
 * the writer; corrected, expired and removed facts stay visible in the file. Binding signatures
 * from the upgrade plan, re-exported from `service.ts`.
 *
 * Every fact keeps the person and the company it came with: a person fact records the person's
 * company, a company fact records the person who told us (when known). `scope` says which one
 * the fact is about, and only that one is its target for lists and duplicates.
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { actorRef, type OpContext, requireWorkspace } from "../../core/context.js";
import type { FactKind, FactScope, FactSource, FactStatus } from "../../core/enums.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { lead_facts } from "../../db/schema/index.js";
import { loadPerson, requireCompany, requirePerson } from "./records.js";

export interface RecordFactInput {
  personId?: string | null;
  companyId?: string | null;
  scope: FactScope;
  kind: FactKind;
  /** One short sentence; whitespace is collapsed and the text cut to 280 characters. */
  text: string;
  source: FactSource;
  /** The record behind the fact: the message id for replies, the CRM name for crm. */
  sourceRef?: string | null;
  /** Default now. */
  observedAt?: Date;
  expiresAt?: Date | null;
}

export type LeadFact = typeof lead_facts.$inferSelect;

/** Longest fact text; longer text is cut. */
const FACT_TEXT_MAX = 280;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

function invalid(message: string, hint: string, field: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", message, { hint, details: { field } });
}

function cleanFactText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, FACT_TEXT_MAX).trim();
}

/** Near-duplicate key: lowercase, punctuation removed, whitespace collapsed and trimmed. */
function normalizeFactText(text: string): string {
  return text.toLowerCase().replace(/\p{P}/gu, "").replace(/\s+/g, " ").trim();
}

/** An active fact whose expiry passed counts as expired, even before the daily job marks it. */
function effective(row: LeadFact, now: Date): LeadFact {
  if (row.status === "active" && row.expires_at && row.expires_at <= now) {
    return { ...row, status: "expired" };
  }
  return row;
}

interface Target {
  scope: FactScope;
  personId: string | null;
  companyId: string | null;
  /** The person id for person facts, the company id for company facts. */
  targetId: string;
}

/** Checks the ids belong to the workspace and resolves the company of a company fact. */
async function resolveTarget(ctx: OpContext, input: RecordFactInput): Promise<Target> {
  const person = input.personId ? await requirePerson(ctx, input.personId) : null;
  const company = input.companyId ? await requireCompany(ctx, input.companyId) : null;
  if (input.scope === "person") {
    if (!person) {
      throw invalid(
        "A person fact needs a person.",
        "Pass personId, or use scope company with companyId for a fact about the whole company.",
        "personId",
      );
    }
    return {
      scope: "person",
      personId: person.id,
      companyId: company?.id ?? person.company_id ?? null,
      targetId: person.id,
    };
  }
  const companyId = company?.id ?? person?.company_id ?? null;
  if (!companyId) {
    throw invalid(
      "A company fact needs a company.",
      person
        ? `Person ${person.id} has no company: pass companyId, or record it as a person fact.`
        : "Pass companyId, or a personId whose person belongs to a company.",
      "companyId",
    );
  }
  return { scope: "company", personId: person?.id ?? null, companyId, targetId: companyId };
}

/**
 * Records a fact about a person (scope `person`, needs `personId`) or a whole company (scope
 * `company`, needs `companyId` or a `personId` whose person has a company). A near-duplicate of
 * an active fact (same target and kind, same text ignoring case, punctuation and spacing)
 * returns that fact's id with `created: false`; otherwise the fact is stored and
 * `lead.fact_recorded` fires.
 */
export async function recordFact(
  ctx: OpContext,
  input: RecordFactInput,
): Promise<{ id: string; created: boolean }> {
  const workspace = requireWorkspace(ctx);
  const text = cleanFactText(input.text);
  const key = normalizeFactText(text);
  if (!key) {
    throw invalid(
      "A fact needs text.",
      `Pass one short sentence in plain words (at most ${FACT_TEXT_MAX} characters).`,
      "text",
    );
  }
  const target = await resolveTarget(ctx, input);
  const now = ctx.clock.now();
  const lockKey = `lead_facts:${workspace.id}:${target.scope}:${target.targetId}`;

  const outcome = await ctx.db.transaction(async (tx) => {
    // One writer per target at a time, so two callers cannot both store the same fact.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const active = await tx
      .select({ id: lead_facts.id, text: lead_facts.text })
      .from(lead_facts)
      .where(
        and(
          eq(lead_facts.workspace_id, workspace.id),
          eq(lead_facts.scope, target.scope),
          target.scope === "person"
            ? eq(lead_facts.person_id, target.targetId)
            : eq(lead_facts.company_id, target.targetId),
          eq(lead_facts.kind, input.kind),
          eq(lead_facts.status, "active"),
          or(isNull(lead_facts.expires_at), gt(lead_facts.expires_at, now)),
        ),
      );
    const duplicate = active.find((fact) => normalizeFactText(fact.text) === key);
    if (duplicate) return { id: duplicate.id, row: null };
    const [row] = await tx
      .insert(lead_facts)
      .values({
        workspace_id: workspace.id,
        person_id: target.personId,
        company_id: target.companyId,
        scope: target.scope,
        kind: input.kind,
        text,
        source: input.source,
        source_ref: input.sourceRef?.trim() || null,
        observed_at: input.observedAt ?? now,
        expires_at: input.expiresAt ?? null,
        created_by: actorRef(ctx.principal),
      })
      .returning();
    if (!row) throw new Error("recordFact: insert returned no row");
    return { id: row.id, row };
  });

  if (!outcome.row) return { id: outcome.id, created: false };
  await ctx.events.emit("lead.fact_recorded", {
    subject: { type: target.scope, id: target.targetId },
    data: {
      fact_id: outcome.row.id,
      person_id: outcome.row.person_id,
      company_id: outcome.row.company_id,
      kind: outcome.row.kind,
      source: outcome.row.source,
    },
  });
  return { id: outcome.id, created: true };
}

/**
 * Facts of a person (person facts) and/or a company (company facts), newest observed first.
 * `includeCompany` adds the company facts of the person's company. `statuses` (default
 * ["active"]) match the effective status: an active fact past its expiry is expired. `limit`
 * default 50, max 200. Needs `personId` or `companyId`.
 */
export async function listFacts(
  ctx: OpContext,
  filter: {
    personId?: string;
    companyId?: string;
    includeCompany?: boolean;
    statuses?: FactStatus[];
    limit?: number;
  },
): Promise<LeadFact[]> {
  const workspace = requireWorkspace(ctx);
  if (!filter.personId && !filter.companyId) {
    throw invalid("Say whose facts to list.", "Pass personId, companyId or both.", "personId");
  }
  const statuses = filter.statuses ?? ["active"];
  if (statuses.length === 0) return [];
  const limit = Math.max(
    1,
    Math.min(Math.trunc(filter.limit ?? LIST_LIMIT_DEFAULT), LIST_LIMIT_MAX),
  );
  const companyIds = filter.companyId ? [filter.companyId] : [];
  if (filter.personId && filter.includeCompany) {
    const person = await loadPerson(ctx, filter.personId);
    if (person?.company_id && !companyIds.includes(person.company_id)) {
      companyIds.push(person.company_id);
    }
  }
  const targets: Array<SQL | undefined> = [];
  if (filter.personId) {
    targets.push(and(eq(lead_facts.scope, "person"), eq(lead_facts.person_id, filter.personId)));
  }
  if (companyIds.length > 0) {
    targets.push(and(eq(lead_facts.scope, "company"), inArray(lead_facts.company_id, companyIds)));
  }

  const now = ctx.clock.now();
  const status = sql`(case when ${lead_facts.status} = 'active' and ${lead_facts.expires_at} <= ${now.toISOString()}::timestamptz then 'expired' else ${lead_facts.status} end)`;
  const rows = await ctx.db
    .select()
    .from(lead_facts)
    .where(
      and(
        eq(lead_facts.workspace_id, workspace.id),
        or(...targets),
        sql`${status} in (${sql.join(
          statuses.map((value) => sql`${value}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(desc(lead_facts.observed_at), desc(lead_facts.created_at), desc(lead_facts.id))
    .limit(limit);
  return rows.map((row) => effective(row, now));
}

/**
 * Sets a fact's status: `corrected` (with `replacedBy`, the fact that corrects it), `removed`,
 * `expired`, or `active` again (which clears `replaced_by` unless one is given). Throws
 * `not_found` for an id outside the workspace.
 */
export async function updateFactStatus(
  ctx: OpContext,
  factId: string,
  status: FactStatus,
  opts: { replacedBy?: string | null } = {},
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  if (opts.replacedBy) {
    if (opts.replacedBy === factId) {
      throw invalid(
        "A fact cannot replace itself.",
        "Pass the id of the new fact that corrects it; if the new text says the same thing, there is nothing to correct.",
        "replacedBy",
      );
    }
    const [replacement] = await ctx.db
      .select({ id: lead_facts.id })
      .from(lead_facts)
      .where(and(eq(lead_facts.workspace_id, workspace.id), eq(lead_facts.id, opts.replacedBy)));
    if (!replacement) throw notFound("Fact", opts.replacedBy);
  }
  const replacedBy =
    opts.replacedBy !== undefined ? opts.replacedBy : status === "active" ? null : undefined;
  const [row] = await ctx.db
    .update(lead_facts)
    .set({
      status,
      ...(replacedBy !== undefined ? { replaced_by: replacedBy } : {}),
      updated_at: ctx.clock.now(),
    })
    .where(and(eq(lead_facts.workspace_id, workspace.id), eq(lead_facts.id, factId)))
    .returning({ id: lead_facts.id });
  if (!row) throw notFound("Fact", factId);
}

/** Ids per statement when facts are deleted or unlinked by many ids. */
const ERASE_BATCH = 500;

function inBatches<T>(values: T[]): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += ERASE_BATCH) {
    batches.push(values.slice(start, start + ERASE_BATCH));
  }
  return batches;
}

/**
 * Erasure of many people at once (retention, bulk delete): deletes their person facts plus
 * every fact taken from one of `messageIds` (source `reply`), in batches, each by an index
 * (person, or source and message id), and returns how many were deleted. Company facts they
 * told us in another way stay (they are about the company) but no longer point at them.
 */
export async function deleteFactsForPeople(
  ctx: OpContext,
  personIds: string[],
  opts: { messageIds?: string[] } = {},
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const ids = [...new Set(personIds)].filter(Boolean);
  const messageIds = [...new Set(opts.messageIds ?? [])].filter(Boolean);
  let deleted = 0;
  for (const batch of inBatches(ids)) {
    const rows = await ctx.db
      .delete(lead_facts)
      .where(
        and(
          eq(lead_facts.workspace_id, workspace.id),
          eq(lead_facts.scope, "person"),
          inArray(lead_facts.person_id, batch),
        ),
      )
      .returning({ id: lead_facts.id });
    deleted += rows.length;
  }
  for (const batch of inBatches(messageIds)) {
    const rows = await ctx.db
      .delete(lead_facts)
      .where(
        and(
          eq(lead_facts.workspace_id, workspace.id),
          eq(lead_facts.source, "reply"),
          inArray(lead_facts.source_ref, batch),
        ),
      )
      .returning({ id: lead_facts.id });
    deleted += rows.length;
  }
  for (const batch of inBatches(ids)) {
    await ctx.db
      .update(lead_facts)
      .set({ person_id: null, updated_at: ctx.clock.now() })
      .where(and(eq(lead_facts.workspace_id, workspace.id), inArray(lead_facts.person_id, batch)));
  }
  return deleted;
}

/**
 * Erasure: deletes the person's person facts plus every fact taken from one of `messageIds`
 * (source `reply`), and returns how many were deleted. Company facts the person told us in
 * another way stay (they are about the company) but no longer point at the person.
 */
export async function deleteFactsForPerson(
  ctx: OpContext,
  personId: string,
  opts: { messageIds?: string[] } = {},
): Promise<number> {
  return deleteFactsForPeople(ctx, [personId], opts);
}

// --- Lead file helpers (beyond the binding contract) ------------------------------------------

/** One fact of the workspace, or null. */
export async function getFact(ctx: OpContext, factId: string): Promise<LeadFact | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(lead_facts)
    .where(and(eq(lead_facts.workspace_id, workspace.id), eq(lead_facts.id, factId)))
    .limit(1);
  return row ? effective(row, ctx.clock.now()) : null;
}

/** The fact's effective status: an active fact past its expiry reads as expired. */
export function effectiveFact(row: LeadFact, now: Date): LeadFact {
  return effective(row, now);
}

/** Same text for duplicate checks: case, punctuation and spacing ignored. */
export function sameFactText(a: string, b: string): boolean {
  return normalizeFactText(cleanFactText(a)) === normalizeFactText(cleanFactText(b));
}

/**
 * Marks active facts whose expiry has passed as `expired` (the daily lead file job) and
 * returns how many changed. Reads already treat them as expired; this makes it stored.
 */
export async function expireFacts(ctx: OpContext): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const rows = await ctx.db
    .update(lead_facts)
    .set({ status: "expired", updated_at: now })
    .where(
      and(
        eq(lead_facts.workspace_id, workspace.id),
        eq(lead_facts.status, "active"),
        isNotNull(lead_facts.expires_at),
        lte(lead_facts.expires_at, now),
      ),
    )
    .returning({ id: lead_facts.id });
  return rows.length;
}

/**
 * For deleted companies (`lead_facts` has no foreign keys): deletes their company facts and
 * unlinks their people's person facts from them. Returns how many facts were deleted.
 */
export async function deleteFactsForCompanies(
  ctx: OpContext,
  companyIds: string[],
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const ids = [...new Set(companyIds)].filter(Boolean);
  if (ids.length === 0) return 0;
  const deleted = await ctx.db
    .delete(lead_facts)
    .where(
      and(
        eq(lead_facts.workspace_id, workspace.id),
        eq(lead_facts.scope, "company"),
        inArray(lead_facts.company_id, ids),
      ),
    )
    .returning({ id: lead_facts.id });
  await ctx.db
    .update(lead_facts)
    .set({ company_id: null, updated_at: ctx.clock.now() })
    .where(and(eq(lead_facts.workspace_id, workspace.id), inArray(lead_facts.company_id, ids)));
  return deleted.length;
}
