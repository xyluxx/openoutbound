/**
 * Keyword lists for collectors: definition keywords plus, for hiring, role words from the
 * workspace ICPs. ICP criteria are owned by the leads module, so they are read defensively:
 * any string list under a key that names titles, functions, roles, departments or keywords.
 */
import { eq } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { icps, type SignalDefinition } from "../../db/schema/index.js";
import type { RunKeywords } from "./collectors/types.js";

const ROLE_KEYS =
  /^(titles?|job_titles|functions?|roles?|departments?|keywords|hiring_keywords|role_keywords)$/i;
const MAX_KEYWORDS = 40;

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.replace(/\s+/g, " ").trim();
    const key = value.toLowerCase();
    if (value.length < 2 || value.length > 60 || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, MAX_KEYWORDS);
}

/** Role words found in an ICP criteria object (skips `exclude*` keys). */
export function icpRoleKeywords(criteria: unknown, depth = 0): string[] {
  if (depth > 4 || typeof criteria !== "object" || criteria === null) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(criteria as Record<string, unknown>)) {
    if (/^exclude/i.test(key)) continue;
    if (ROLE_KEYS.test(key) && Array.isArray(value)) {
      out.push(...value.filter((item): item is string => typeof item === "string"));
    } else if (typeof value === "object" && value !== null) {
      out.push(...icpRoleKeywords(value, depth + 1));
    }
  }
  return out;
}

export async function buildRunKeywords(
  ctx: OpContext,
  workspaceId: string,
  definitions: readonly SignalDefinition[],
): Promise<RunKeywords> {
  const keywordsOf = (key: string) =>
    definitions.find((definition) => definition.key === key)?.detection.keywords ?? [];
  const rows = await ctx.db
    .select({ criteria: icps.criteria })
    .from(icps)
    .where(eq(icps.workspace_id, workspaceId));
  return {
    hiring: dedupe([
      ...keywordsOf("hiring_relevant_roles"),
      ...rows.flatMap((row) => icpRoleKeywords(row.criteria)),
    ]),
    tech: dedupe([...keywordsOf("tech_adopted"), ...keywordsOf("tech_removed")]),
    competitors: dedupe(keywordsOf("competitor_mention")),
  };
}
