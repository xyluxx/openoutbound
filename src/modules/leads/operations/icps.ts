/** ICP operations: ideal customer profiles and fit scoring. */
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import {
  defineOperation,
  isoDateTime,
  jobHandleOutput,
  paginated,
  paginationInput,
} from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { type Icp, icps } from "../../../db/schema/index.js";
import { leadFilterSchema } from "../filters.js";
import { loadIcp } from "../icp/apply.js";
import {
  describeCriteria,
  icpCriteriaSchema,
  icpScoringSchema,
  parseIcp,
} from "../icp/criteria.js";
import {
  countSelection,
  ICP_SCORE_JOB,
  SCORE_LIMITS,
  type ScoreSelection,
  scoreSelection,
} from "../icp/rescore.js";
import { createIcpRecord, deleteIcpRecord, requireIcp, updateIcpRecord } from "../icp/store.js";
import { EXAMPLE } from "./shapes.js";

const icpView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_default: z.boolean(),
  summary: z.string().describe("Criteria in one short text"),
  criteria: icpCriteriaSchema,
  scoring: icpScoringSchema,
  signal_keys: z.array(z.string()),
  created_at: isoDateTime(),
  updated_at: isoDateTime(),
});

function toView(row: Icp) {
  const parsed = parseIcp(row);
  return {
    ...row,
    summary: describeCriteria(parsed.criteria) || "No criteria yet",
    criteria: parsed.criteria,
    scoring: parsed.scoring,
  };
}

export const listIcps = defineOperation({
  id: "icps.list",
  summary: "List ideal customer profiles",
  description:
    "Lists the workspace's ideal customer profiles (ICPs) with a one-line criteria summary; the default ICP scores imports and find previews. Use it to pick an icp_id for find_leads, import_leads or scoring. Not for changing criteria: use manage_icp action update. Most workspaces need one or two ICPs.",
  effect: "read",
  input: paginationInput,
  output: paginated(icpView),
  http: { method: "GET", path: "/v1/icps" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "All ICPs", input: { limit: 25 } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(icps.workspace_id, workspace.id)];
    if (input.cursor) {
      const { id } = decodeCursor<{ id?: string }>(input.cursor);
      if (typeof id === "string") conditions.push(sql`${icps.id} > ${id}`);
    }
    const rows = await ctx.db
      .select()
      .from(icps)
      .where(and(...conditions))
      .orderBy(asc(icps.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }), toView);
  },
});

export const getIcp = defineOperation({
  id: "icps.get",
  summary: "Get one ICP with all criteria and weights",
  description:
    "Returns one ICP with every criterion, weight and exclusion filled with defaults, plus a one-line summary. Use it before editing criteria or to explain why leads score the way they do. Not for scoring leads (use manage_icp action score). Weights are points per criterion; only criteria you set count toward the 0-100 score.",
  effect: "read",
  input: z.object({ icp_id: idSchema("icp") }),
  output: icpView,
  http: { method: "GET", path: "/v1/icps/:icp_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Read an ICP", input: { icp_id: EXAMPLE.icp } }],
  handler: async (ctx, input) => toView(await requireIcp(ctx, input.icp_id)),
});

export const createIcp = defineOperation({
  id: "icps.create",
  summary: "Create an ideal customer profile",
  description:
    "Creates an ICP from criteria (industries, keywords, titles, seniorities, departments, employee range and limits, countries, regions, technologies and exclusions) with optional weights and AI refinement; the first ICP becomes the default. Use it during setup or when a new offer targets a different segment, then run manage_icp action score to rescore stored leads. Not for one-off searches: pass filters to find_leads or search_leads instead. Only the criteria you set count; unknown values earn part of the weight (unknown_share).",
  effect: "write",
  input: z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    criteria: icpCriteriaSchema.optional(),
    scoring: icpScoringSchema.optional(),
    signal_keys: z
      .array(z.string().max(80))
      .max(30)
      .optional()
      .describe("Signals that matter for this ICP"),
    is_default: z
      .boolean()
      .optional()
      .describe("Use for scoring by default (the first ICP always is)"),
  }),
  output: icpView,
  http: { method: "POST", path: "/v1/icps" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Dental practices in Texas",
      input: {
        name: "Texas dental practices",
        criteria: {
          industries: ["dental clinic"],
          titles: ["practice manager", "owner"],
          employee_range: { min: 5, max: 50 },
          countries: ["US"],
          regions: ["TX"],
        },
      },
    },
  ],
  handler: async (ctx, input) =>
    toView(
      await createIcpRecord(ctx, {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.criteria !== undefined
          ? { criteria: input.criteria as Record<string, unknown> }
          : {}),
        ...(input.scoring !== undefined
          ? { scoring: input.scoring as Record<string, unknown> }
          : {}),
        ...(input.signal_keys !== undefined ? { signal_keys: input.signal_keys } : {}),
        ...(input.is_default !== undefined ? { is_default: input.is_default } : {}),
      }),
    ),
});

export const updateIcp = defineOperation({
  id: "icps.update",
  summary: "Change an ICP's criteria, weights or default flag",
  description:
    "Updates an ICP: criteria and scoring are replaced as a whole when given (read the current values with manage_icp action get first), and is_default true makes it the workspace default. Use it after learning which segments reply. Stored fit scores do not change until you run manage_icp action score. Not for searching or filtering leads.",
  effect: "write",
  input: z.object({
    icp_id: idSchema("icp"),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    criteria: icpCriteriaSchema.optional(),
    scoring: icpScoringSchema.optional(),
    signal_keys: z.array(z.string().max(80)).max(30).optional(),
    is_default: z.boolean().optional(),
  }),
  output: icpView,
  http: { method: "PATCH", path: "/v1/icps/:icp_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Make an ICP the default",
      input: { icp_id: EXAMPLE.icp, is_default: true },
    },
  ],
  handler: async (ctx, input) =>
    toView(
      await updateIcpRecord(ctx, input.icp_id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.criteria !== undefined
          ? { criteria: input.criteria as Record<string, unknown> }
          : {}),
        ...(input.scoring !== undefined
          ? { scoring: input.scoring as Record<string, unknown> }
          : {}),
        ...(input.signal_keys !== undefined ? { signal_keys: input.signal_keys } : {}),
        ...(input.is_default !== undefined ? { is_default: input.is_default } : {}),
      }),
    ),
});

export const deleteIcp = defineOperation({
  id: "icps.delete",
  summary: "Delete an ICP",
  description:
    "Deletes an ICP; stored fit scores stay until leads are rescored. Use it for profiles you no longer target. If it was the default, the most recently updated remaining ICP becomes the default. Saved searches that used it fall back to the default ICP.",
  effect: "destructive",
  input: z.object({ icp_id: idSchema("icp") }),
  output: z.object({ deleted: z.boolean(), new_default_id: z.string().nullable() }),
  http: { method: "DELETE", path: "/v1/icps/:icp_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Delete an old ICP", input: { icp_id: EXAMPLE.icp } }],
  handler: async (ctx, input) => {
    const { newDefaultId } = await deleteIcpRecord(ctx, input.icp_id);
    return { deleted: true, new_default_id: newDefaultId };
  },
});

/** Explicit ids per call (a request size bound; lists, filters and all_* have no limit). */
const MAX_IDS = 20_000;

export const scoreLeads = defineOperation({
  id: "icps.score",
  summary: "Rescore people and companies against an ICP",
  description:
    "Computes the rule-based fit score (0-100, with a reason per criterion) for people chosen by ids, a list or a filter, and/or companies, and stores it (fit_score, fit_reasons). Use it after creating or changing an ICP; imports and find previews already score automatically. Not for AI refinement of a whole database: that only runs on the top candidates of a find preview. Pass all_people true to rescore everyone: up to 20,000 people and companies are scored right away, larger selections are scored in batches by a background job (follow it with get_job).",
  effect: "write",
  input: z.object({
    icp_id: idSchema("icp").optional().describe("Default: the workspace default ICP"),
    person_ids: z.array(idSchema("pe")).max(MAX_IDS).optional(),
    list_id: idSchema("ls").optional(),
    filter: leadFilterSchema.optional(),
    company_ids: z.array(idSchema("co")).max(MAX_IDS).optional(),
    all_people: z.boolean().default(false),
    all_companies: z.boolean().default(false),
  }),
  output: z.union([
    z.object({
      icp_id: z.string(),
      people_scored: z.number().int(),
      companies_scored: z.number().int(),
      average_person_score: z.number().nullable(),
      distribution: z.object({
        strong: z.number().int().describe("70-100"),
        medium: z.number().int().describe("40-69"),
        weak: z.number().int().describe("0-39"),
        unscored: z.number().int(),
      }),
    }),
    jobHandleOutput.extend({
      icp_id: z.string(),
      people: z.number().int().describe("People the job scores"),
      companies: z.number().int().describe("Companies the job scores"),
    }),
  ]),
  http: { method: "POST", path: "/v1/icps/score" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Rescore everyone with the default ICP", input: { all_people: true } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const icp = await loadIcp(ctx, input.icp_id);
    if (!icp) {
      throw new OpenOutboundError("validation_failed", "There is no ICP to score with.", {
        hint: "Create one with manage_icp action create, then score again.",
      });
    }
    const selection: ScoreSelection = {
      person_ids: input.person_ids,
      list_id: input.list_id,
      filter: input.filter,
      all_people: input.all_people,
      company_ids: input.company_ids,
      all_companies: input.all_companies,
    };
    const count = await countSelection(ctx, selection);
    if (count.people === 0 && count.companies === 0) {
      throw new OpenOutboundError("validation_failed", "Nothing selected to score.", {
        hint: "Pass person_ids, list_id, filter, company_ids, all_people or all_companies.",
      });
    }
    if (count.people + count.companies > SCORE_LIMITS.inline) {
      const key = createHash("sha256")
        .update(JSON.stringify([workspace.id, icp.id, selection]))
        .digest("hex")
        .slice(0, 24);
      const handle = await ctx.jobs.enqueue(
        ICP_SCORE_JOB,
        { icp_id: icp.id, selection },
        { singletonKey: `${ICP_SCORE_JOB}:${key}` },
      );
      return { ...handle, icp_id: icp.id, people: count.people, companies: count.companies };
    }
    return { icp_id: icp.id, ...(await scoreSelection(ctx, icp, selection)) };
  },
});
