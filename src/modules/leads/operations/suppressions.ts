/** Suppression operations: list, add, remove and check. */
import { and, asc, eq, gt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import {
  SUPPRESSION_REASONS,
  SUPPRESSION_TYPES,
  type SuppressionType,
} from "../../../core/enums.js";
import { notFound, OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import {
  defineOperation,
  isoDateTime,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { people, suppressions } from "../../../db/schema/index.js";
import { stopEnrollmentsForPerson } from "../../campaigns/service.js";
import { emailDomain } from "../normalize.js";
import {
  addSuppressionRow,
  findSuppressions,
  normalizeSuppressionValue,
  suppressionCandidates,
} from "../suppressions.js";
import { EXAMPLE } from "./shapes.js";

const suppressionItem = z.object({
  id: z.string(),
  type: z.enum(SUPPRESSION_TYPES),
  value: z.string().describe("Normalized value; sha256:... for erased people"),
  reason: z.enum(SUPPRESSION_REASONS),
  note: z.string().nullable(),
  source: z.string().nullable(),
  created_at: isoDateTime(),
});

const MANUAL_REASONS = SUPPRESSION_REASONS.filter((r) => r !== "gdpr_erasure") as [
  Exclude<(typeof SUPPRESSION_REASONS)[number], "gdpr_erasure">,
  ...Array<Exclude<(typeof SUPPRESSION_REASONS)[number], "gdpr_erasure">>,
];

export const listSuppressions = defineOperation({
  id: "suppressions.list",
  summary: "List suppressed emails, domains, LinkedIn URLs, people and companies",
  description:
    "Lists the workspace suppression list, newest first, filtered by type, reason or a value fragment. Everything on it is never contacted and never imported again: unsubscribes, bounces, complaints, manual blocks, customers, competitors and GDPR erasures (stored only as sha256 hashes). Use it to audit why someone is blocked; to test one address or person use manage_suppressions action check. Hashed values cannot be searched by fragment.",
  effect: "read",
  input: paginationInput.extend({
    type: z.enum(SUPPRESSION_TYPES).optional(),
    suppression_reason: z.enum(SUPPRESSION_REASONS).optional(),
    query: z.string().max(200).optional().describe("Part of the value, e.g. a domain"),
  }),
  output: paginated(suppressionItem),
  http: { method: "GET", path: "/v1/suppressions" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Recent unsubscribes", input: { suppression_reason: "unsubscribed", limit: 25 } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(suppressions.workspace_id, workspace.id)];
    if (input.type) conditions.push(eq(suppressions.type, input.type));
    if (input.suppression_reason)
      conditions.push(eq(suppressions.reason, input.suppression_reason));
    if (input.query) {
      conditions.push(
        sql`${suppressions.value} ilike ${`%${input.query
          .trim()
          .toLowerCase()
          .replace(/[\\%_]/g, "")}%`}`,
      );
    }
    if (input.cursor) {
      const { id } = decodeCursor<{ id?: string }>(input.cursor);
      if (typeof id === "string") conditions.push(sql`${suppressions.id} < ${id}`);
    }
    const rows = await ctx.db
      .select()
      .from(suppressions)
      .where(and(...conditions))
      .orderBy(sql`${suppressions.id} desc`)
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }));
  },
});

/** People read per batch when a new suppression stops their campaigns. */
export const COVERED_BATCH = { size: 500 };

/** Condition on people for everyone a suppression covers (null for types that cover no one). */
function coveredCondition(type: SuppressionType, value: string): SQL | null {
  switch (type) {
    case "email":
      return eq(people.email, value);
    case "linkedin":
      return eq(people.linkedin_url, value);
    case "person":
      return eq(people.id, value);
    case "company":
      return eq(people.company_id, value);
    case "domain":
      return (
        or(
          sql`split_part(${people.email}, '@', 2) = ${value}`,
          sql`exists (select 1 from companies c where c.id = ${people.company_id} and c.domain = ${value})`,
        ) ?? null
      );
    default:
      return null;
  }
}

/**
 * Stops the campaigns of everyone the suppression covers, reading people with an enrollment in
 * progress in id order a batch at a time, so no one is left out. Returns how many people it
 * covers and how many enrollments stopped (null when the campaigns module is unavailable).
 */
async function stopCoveredCampaigns(
  ctx: OpContext,
  type: SuppressionType,
  value: string,
): Promise<{ covered: number; stopped: number | null }> {
  const workspace = requireWorkspace(ctx);
  const condition = coveredCondition(type, value);
  if (!condition) return { covered: 0, stopped: 0 };
  const scope = and(eq(people.workspace_id, workspace.id), condition);
  const [count] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(people).where(scope);
  const covered = Number(count?.n ?? 0);
  const enrolled = sql`exists (select 1 from enrollments e where e.person_id = ${people.id} and e.status in ('queued', 'active', 'paused', 'waiting_review'))`;
  const reason = `suppressed_${type}`;
  let stopped = 0;
  let after: string | null = null;
  for (;;) {
    const rows: Array<{ id: string }> = await ctx.db
      .select({ id: people.id })
      .from(people)
      .where(and(scope, enrolled, after ? gt(people.id, after) : undefined))
      .orderBy(asc(people.id))
      .limit(COVERED_BATCH.size);
    for (const row of rows) {
      try {
        stopped += await stopEnrollmentsForPerson(ctx, { personId: row.id, reason });
      } catch {
        return { covered, stopped: null };
      }
    }
    if (rows.length < COVERED_BATCH.size) return { covered, stopped };
    after = rows[rows.length - 1]?.id ?? null;
  }
}

export const addSuppressionOp = defineOperation({
  id: "suppressions.add",
  summary: "Suppress an email, domain, LinkedIn URL, person or company",
  description:
    "Adds a value to the suppression list so it is never contacted or imported again, and stops running campaigns for every person it covers (a whole domain included). Use it when someone asks not to be contacted, for competitors, customers or whole domains you must avoid. Not for privacy erasure requests: use manage_leads action forget, which also deletes their data. Adding the same value twice is harmless (created false).",
  effect: "write",
  input: z.object({
    type: z.enum(SUPPRESSION_TYPES),
    value: z
      .string()
      .min(1)
      .max(500)
      .describe("Email, domain, LinkedIn URL, person id or company id"),
    suppression_reason: z
      .enum(MANUAL_REASONS)
      .default("manual")
      .describe("Why the value is blocked (gdpr_erasure is set only by forget)"),
    note: z.string().max(500).optional(),
  }),
  output: z.object({
    suppression: suppressionItem,
    created: z.boolean(),
    people_covered: z.number().int(),
    enrollments_stopped: z.number().int().nullable(),
  }),
  http: { method: "POST", path: "/v1/suppressions" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Block a competitor's domain",
      input: { type: "domain", value: "rival.example.com", suppression_reason: "competitor" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const { created, value } = await addSuppressionRow(ctx, {
      type: input.type,
      value: input.value,
      reason: input.suppression_reason,
      source: "api",
      note: input.note ?? null,
    });
    const [row] = await ctx.db
      .select()
      .from(suppressions)
      .where(
        and(
          eq(suppressions.workspace_id, workspace.id),
          eq(suppressions.type, input.type),
          eq(suppressions.value, value),
        ),
      );
    if (!row) throw new Error("suppression row missing after insert");
    const { covered, stopped } = await stopCoveredCampaigns(ctx, input.type, value);
    return {
      suppression: row,
      created,
      people_covered: covered,
      enrollments_stopped: stopped,
    };
  },
});

export const removeSuppression = defineOperation({
  id: "suppressions.remove",
  summary: "Remove a suppression (needs approve scope)",
  description:
    "Removes one value from the suppression list so it can be contacted again. Only do this when the person or company explicitly asked to hear from you again or the entry was a mistake; the caller needs the approve scope. GDPR erasure entries can never be removed. Not for pausing outreach (use campaign controls) and not for deleting leads.",
  effect: "write",
  scopes: ["write", "approve"],
  input: z.object({
    suppression_id: idSchema("sup").optional(),
    type: z.enum(SUPPRESSION_TYPES).optional(),
    value: z.string().max(500).optional(),
  }),
  output: z.object({ removed: z.boolean(), suppression: suppressionItem }),
  http: { method: "POST", path: "/v1/suppressions/remove" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Undo a mistaken block", input: { suppression_id: EXAMPLE.suppression } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    let condition: SQL | undefined;
    if (input.suppression_id) {
      condition = eq(suppressions.id, input.suppression_id);
    } else if (input.type && input.value) {
      const value = normalizeSuppressionValue(input.type, input.value);
      if (!value) {
        throw new OpenOutboundError(
          "validation_failed",
          `"${input.value}" is not a valid ${input.type}.`,
          {
            hint: "Pass the value as listed by manage_suppressions action list, or the suppression_id.",
          },
        );
      }
      condition = and(eq(suppressions.type, input.type), eq(suppressions.value, value));
    } else {
      throw new OpenOutboundError("validation_failed", "Say which suppression to remove.", {
        hint: "Pass suppression_id, or type and value.",
      });
    }
    const [row] = await ctx.db
      .select()
      .from(suppressions)
      .where(and(eq(suppressions.workspace_id, workspace.id), condition));
    if (!row) throw notFound("Suppression", input.suppression_id ?? input.value ?? "");
    if (row.reason === "gdpr_erasure") {
      throw new OpenOutboundError("forbidden", "GDPR erasure suppressions cannot be removed.", {
        hint: "The person asked to be forgotten; they must not be contacted or re-imported.",
        details: { suppression_id: row.id },
      });
    }
    await ctx.db
      .delete(suppressions)
      .where(and(eq(suppressions.id, row.id), eq(suppressions.workspace_id, workspace.id)));
    return { removed: true, suppression: row };
  },
});

export const checkSuppression = defineOperation({
  id: "suppressions.check",
  summary: "Check whether an address, domain, profile, person or company is suppressed",
  description:
    "Checks one or more identifiers (email, domain, LinkedIn URL, person id, company id) against the suppression list, including hashed GDPR erasures and the domain of the email. Use it before adding or messaging someone by hand. For a full may-we-contact answer with status, consent and country rules use get_lead, which reports contactability per channel. Returns every matching entry with its reason.",
  effect: "read",
  input: z.object({
    email: z.string().max(320).optional(),
    domain: z.string().max(253).optional(),
    linkedin_url: z.string().max(500).optional(),
    person_id: idSchema("pe").optional(),
    company_id: idSchema("co").optional(),
  }),
  output: z.object({
    suppressed: z.boolean(),
    matches: z.array(suppressionItem),
  }),
  http: { method: "POST", path: "/v1/suppressions/check" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Check an address", input: { email: "dana@brightsmile.example.com" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (
      !input.email &&
      !input.domain &&
      !input.linkedin_url &&
      !input.person_id &&
      !input.company_id
    ) {
      throw new OpenOutboundError("validation_failed", "Nothing to check.", {
        hint: "Pass email, domain, linkedin_url, person_id or company_id.",
      });
    }
    const candidates = suppressionCandidates({
      email: input.email ?? null,
      linkedin_url: input.linkedin_url ?? null,
      person_id: input.person_id ?? null,
      company_id: input.company_id ?? null,
      company_domain: input.domain ?? (input.email ? emailDomain(input.email) : null),
    });
    const matches = await findSuppressions(ctx.db, workspace.id, candidates);
    return { suppressed: matches.length > 0, matches };
  },
});
