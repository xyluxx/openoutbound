/**
 * Suppression list: normalization of values, hashed values for GDPR erasure, lookups.
 *
 * Values are stored normalized (lowercase email, bare domain, canonical LinkedIn URL, record
 * id). Erased people leave a hashed value (`sha256:<hex>` of the normalized email or LinkedIn
 * URL) so they are never contacted or imported again while their address is not kept.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { SuppressionReason, SuppressionType } from "../../core/enums.js";
import { invalid } from "../../core/errors.js";
import type { Db } from "../../db/client.js";
import { type Suppression, suppressions } from "../../db/schema/index.js";
import { normalizeDomain } from "../../lib/web/extract.js";
import { emailDomain, normalizeEmail, normalizePersonLinkedin } from "./normalize.js";

export const HASH_PREFIX = "sha256:";
const HASHED = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<hex>` of an already normalized value. */
export function hashSuppressionValue(normalized: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(normalized).digest("hex")}`;
}

export function isHashedValue(value: string): boolean {
  return HASHED.test(value);
}

/**
 * Normalized value for a suppression of this type, or null when the value is not valid for
 * the type. Hashed values (`sha256:...`) pass through for email and linkedin.
 */
export function normalizeSuppressionValue(type: SuppressionType, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((type === "email" || type === "linkedin") && isHashedValue(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }
  switch (type) {
    case "email":
      return normalizeEmail(trimmed);
    case "domain":
      return normalizeDomain(trimmed.replace(/^@/, ""));
    case "linkedin":
      return normalizePersonLinkedin(trimmed);
    case "person":
    case "company":
      return /^[a-z]+_[0-9a-z]{26}$/.test(trimmed) ? trimmed : null;
  }
}

export interface SuppressionCandidate {
  type: SuppressionType;
  value: string;
}

/** Every suppression value that would block this person (plain and hashed forms). */
export function suppressionCandidates(input: {
  email?: string | null;
  linkedin_url?: string | null;
  person_id?: string | null;
  company_id?: string | null;
  company_domain?: string | null;
}): SuppressionCandidate[] {
  const out: SuppressionCandidate[] = [];
  const email = input.email ? normalizeEmail(input.email) : null;
  if (email) {
    out.push(
      { type: "email", value: email },
      { type: "email", value: hashSuppressionValue(email) },
    );
    const domain = emailDomain(email);
    if (domain) out.push({ type: "domain", value: domain });
  }
  const companyDomain = input.company_domain ? normalizeDomain(input.company_domain) : null;
  if (companyDomain && !out.some((c) => c.type === "domain" && c.value === companyDomain)) {
    out.push({ type: "domain", value: companyDomain });
  }
  const linkedin = input.linkedin_url ? normalizePersonLinkedin(input.linkedin_url) : null;
  if (linkedin) {
    out.push(
      { type: "linkedin", value: linkedin },
      { type: "linkedin", value: hashSuppressionValue(linkedin) },
    );
  }
  if (input.person_id) out.push({ type: "person", value: input.person_id });
  if (input.company_id) out.push({ type: "company", value: input.company_id });
  return out;
}

/** Suppressions in the workspace matching any of the candidates (chunked queries). */
export async function findSuppressions(
  db: Db,
  workspaceId: string,
  candidates: SuppressionCandidate[],
): Promise<Suppression[]> {
  if (candidates.length === 0) return [];
  const byType = new Map<SuppressionType, Set<string>>();
  for (const candidate of candidates) {
    const set = byType.get(candidate.type) ?? new Set<string>();
    set.add(candidate.value);
    byType.set(candidate.type, set);
  }
  const found: Suppression[] = [];
  for (const [type, values] of byType) {
    const list = [...values];
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      found.push(
        ...(await db
          .select()
          .from(suppressions)
          .where(
            and(
              eq(suppressions.workspace_id, workspaceId),
              eq(suppressions.type, type),
              inArray(suppressions.value, chunk),
            ),
          )),
      );
    }
  }
  return found;
}

/** Index of suppressions by `type:value` for fast matching. */
export function suppressionIndex(rows: Suppression[]): Map<string, Suppression> {
  return new Map(rows.map((row) => [`${row.type}:${row.value}`, row]));
}

/** Stable reason code for a matched suppression, e.g. `suppressed_email`. */
export function suppressionReason(type: SuppressionType): string {
  return `suppressed_${type}`;
}

/** First suppression that blocks these candidates, if any. */
export function matchSuppression(
  index: Map<string, Suppression>,
  candidates: SuppressionCandidate[],
): Suppression | null {
  for (const candidate of candidates) {
    const hit = index.get(`${candidate.type}:${candidate.value}`);
    if (hit) return hit;
  }
  return null;
}

/** Adds a suppression; idempotent on (type, value). Returns whether a row was created. */
export async function addSuppressionRow(
  ctx: OpContext,
  input: {
    type: SuppressionType;
    value: string;
    reason: SuppressionReason;
    source: string;
    note?: string | null;
  },
): Promise<{ created: boolean; value: string }> {
  const workspace = requireWorkspace(ctx);
  const value = normalizeSuppressionValue(input.type, input.value);
  if (!value) {
    throw invalid(`"${input.value}" is not a valid ${input.type} suppression value.`, {
      type: input.type,
    });
  }
  const inserted = await ctx.db
    .insert(suppressions)
    .values({
      workspace_id: workspace.id,
      type: input.type,
      value,
      reason: input.reason,
      source: input.source,
      note: input.note ?? null,
    })
    .onConflictDoNothing({
      target: [suppressions.workspace_id, suppressions.type, suppressions.value],
    })
    .returning({ id: suppressions.id });
  return { created: inserted.length > 0, value };
}

/**
 * Deletes plain-text email/linkedin suppressions (used when a hashed one replaces them) and the
 * block on a person record that is being erased.
 */
export async function deletePlainSuppressions(
  db: Db,
  workspaceId: string,
  values: { email?: string | null; linkedin?: string | null; personId?: string | null },
): Promise<void> {
  const conditions = [];
  if (values.email)
    conditions.push(and(eq(suppressions.type, "email"), eq(suppressions.value, values.email)));
  if (values.linkedin)
    conditions.push(
      and(eq(suppressions.type, "linkedin"), eq(suppressions.value, values.linkedin)),
    );
  if (values.personId)
    conditions.push(and(eq(suppressions.type, "person"), eq(suppressions.value, values.personId)));
  if (conditions.length === 0) return;
  await db
    .delete(suppressions)
    .where(and(eq(suppressions.workspace_id, workspaceId), or(...conditions)));
}
