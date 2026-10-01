/** opportunities.* operations (manage_pipeline). */
import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { OPPORTUNITY_STAGES } from "../../core/enums.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import {
  dateTimeInput,
  defineOperation,
  paginated,
  paginationInput,
} from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { type Opportunity, opportunities } from "../../db/schema/index.js";
import {
  collectSourceSignalKeys,
  createOpportunity,
  getOpportunity,
  type OpportunityPatch,
  updateOpportunity,
} from "./opportunities.js";
import { findCampaign, findCompany, findPerson, findThread } from "./reply-context.js";
import { currencyInput, opportunityView } from "./schemas.js";

const OPPORTUNITY_EXAMPLE_ID = "opp_01k6a3v0q8x3m2n4p5r6s7t8v9";

const changeOutput = opportunityView.extend({
  changed: z.boolean(),
  effects: z.array(z.string()).describe("Side effects, e.g. enrollments_stopped"),
});

async function requireOpportunity(ctx: OpContext, id: string): Promise<Opportunity> {
  const row = await getOpportunity(ctx, id);
  if (!row) throw notFound("Opportunity", id);
  return row;
}

export const listOpportunities = defineOperation({
  id: "opportunities.list",
  summary: "List pipeline opportunities",
  description:
    "Lists opportunities (interested, meeting_booked, won, lost), newest first, with value, meeting time, the signal keys that led to them and CRM ids. Use it to review the pipeline or find a person's deal before updating it. Use get_report (pipeline) for totals and conversion rates. Opportunities are created automatically from interested replies and booked meetings.",
  effect: "read",
  input: paginationInput.extend({
    stage: z.array(z.enum(OPPORTUNITY_STAGES)).optional(),
    person_id: idSchema("pe").optional(),
    company_id: idSchema("co").optional(),
    campaign_id: idSchema("cmp").optional(),
  }),
  output: paginated(opportunityView),
  http: { method: "GET", path: "/v1/opportunities" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Open pipeline", input: { stage: ["interested", "meeting_booked"] } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [eq(opportunities.workspace_id, workspace.id)];
    if (input.stage?.length) conditions.push(inArray(opportunities.stage, input.stage));
    if (input.person_id) conditions.push(eq(opportunities.person_id, input.person_id));
    if (input.company_id) conditions.push(eq(opportunities.company_id, input.company_id));
    if (input.campaign_id) conditions.push(eq(opportunities.campaign_id, input.campaign_id));
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(lt(opportunities.id, cursor.id));
    }
    const rows = await ctx.db
      .select()
      .from(opportunities)
      .where(and(...conditions))
      .orderBy(desc(opportunities.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }));
  },
});

export const createOpportunityOperation = defineOperation({
  id: "opportunities.create",
  summary: "Add an opportunity to the pipeline",
  description:
    "Creates an opportunity for a person (or a company) at stage interested or meeting_booked, with optional value, currency, meeting time and notes. Use it for deals that started outside a tracked reply, e.g. a call or an event. Interested replies and booked meetings create opportunities automatically, so check the list action first to avoid duplicates. meeting_booked stops the person's sequences (campaign stop.on_meeting).",
  effect: "write",
  input: z.object({
    person_id: idSchema("pe").optional(),
    company_id: idSchema("co").optional(),
    thread_id: idSchema("thr").optional(),
    campaign_id: idSchema("cmp").optional(),
    stage: z.enum(["interested", "meeting_booked"]).default("interested"),
    value: z.number().nonnegative().optional(),
    currency: currencyInput.optional(),
    meeting_at: dateTimeInput().optional(),
    notes: z.string().max(4000).optional(),
  }),
  output: changeOutput,
  http: { method: "POST", path: "/v1/opportunities" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Deal from an event",
      input: {
        person_id: "pe_01k6a3v0q8x3m2n4p5r6s7t8v9",
        value: 12000,
        currency: "EUR",
        notes: "Met at the dental supply fair",
      },
    },
  ],
  handler: async (ctx, input) => {
    if (!input.person_id && !input.company_id) {
      throw new OpenOutboundError(
        "validation_failed",
        "An opportunity needs person_id or company_id.",
        {
          hint: "Find the lead with search_leads, then pass its person_id.",
        },
      );
    }
    const person = input.person_id ? await findPerson(ctx, input.person_id) : null;
    if (input.person_id && !person) throw notFound("Person", input.person_id);
    const companyId = input.company_id ?? person?.company_id ?? null;
    if (input.company_id && !(await findCompany(ctx, input.company_id))) {
      throw notFound("Company", input.company_id);
    }
    if (input.thread_id && !(await findThread(ctx, input.thread_id))) {
      throw notFound("Thread", input.thread_id);
    }
    if (input.campaign_id && !(await findCampaign(ctx, input.campaign_id))) {
      throw notFound("Campaign", input.campaign_id);
    }
    const keys = person
      ? await collectSourceSignalKeys(ctx, {
          personId: person.id,
          threadId: input.thread_id ?? null,
          campaignId: input.campaign_id ?? null,
        })
      : [];
    const { opportunity, effects } = await createOpportunity(ctx, {
      person_id: person?.id ?? null,
      company_id: companyId,
      thread_id: input.thread_id ?? null,
      campaign_id: input.campaign_id ?? null,
      stage: input.stage,
      value: input.value ?? null,
      currency: input.currency ?? null,
      meeting_at: input.meeting_at ?? null,
      notes: input.notes ?? null,
      source_signal_keys: keys,
    });
    return { ...opportunity, changed: true, effects };
  },
});

async function change(ctx: OpContext, id: string, patch: OpportunityPatch) {
  const current = await requireOpportunity(ctx, id);
  const { opportunity, changed, effects } = await updateOpportunity(ctx, current, patch);
  return { ...opportunity, changed, effects };
}

export const updateOpportunityOperation = defineOperation({
  id: "opportunities.update",
  summary: "Update an opportunity (stage, value, meeting time, notes)",
  description:
    "Updates an opportunity: stage (interested -> meeting_booked -> won or lost), value, currency, meeting time, lost reason or notes. Moving to meeting_booked stops the person's sequences; won marks the person a customer. Use the won and lost actions for closing, which ask for the right fields. Every change emits opportunity.updated, which syncs the configured CRM when crm.mode is built_in (live, or once a day with crm.timing daily).",
  effect: "write",
  input: z.object({
    opportunity_id: idSchema("opp"),
    stage: z.enum(OPPORTUNITY_STAGES).optional(),
    value: z.number().nonnegative().nullable().optional(),
    currency: currencyInput.nullable().optional(),
    meeting_at: dateTimeInput().nullable().optional(),
    lost_reason: z.string().max(500).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  }),
  output: changeOutput,
  http: { method: "PATCH", path: "/v1/opportunities/:opportunity_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Meeting booked",
      input: {
        opportunity_id: OPPORTUNITY_EXAMPLE_ID,
        stage: "meeting_booked",
        meeting_at: "2026-10-06T15:00:00Z",
      },
    },
  ],
  handler: (ctx, input) => {
    const patch: OpportunityPatch = {};
    if (input.stage !== undefined) patch.stage = input.stage;
    if (input.value !== undefined) patch.value = input.value;
    if (input.currency !== undefined) patch.currency = input.currency;
    if (input.meeting_at !== undefined) patch.meeting_at = input.meeting_at;
    if (input.lost_reason !== undefined) patch.lost_reason = input.lost_reason;
    if (input.notes !== undefined) patch.notes = input.notes;
    return change(ctx, input.opportunity_id, patch);
  },
});

export const wonOpportunity = defineOperation({
  id: "opportunities.won",
  summary: "Mark an opportunity won",
  description:
    "Closes an opportunity as won, optionally with the final value, currency and notes; the person becomes a customer and every sequence to them and their company stops. Use it when the deal is signed. Use lost for deals that ended without a sale. The CRM is updated automatically.",
  effect: "write",
  input: z.object({
    opportunity_id: idSchema("opp"),
    value: z.number().nonnegative().optional(),
    currency: currencyInput.optional(),
    notes: z.string().max(4000).optional(),
  }),
  output: changeOutput,
  http: { method: "POST", path: "/v1/opportunities/:opportunity_id/won" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Won",
      input: { opportunity_id: OPPORTUNITY_EXAMPLE_ID, value: 9600, currency: "EUR" },
    },
  ],
  handler: (ctx, input) =>
    change(ctx, input.opportunity_id, {
      stage: "won",
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    }),
});

export const lostOpportunity = defineOperation({
  id: "opportunities.lost",
  summary: "Mark an opportunity lost with a reason",
  description:
    "Closes an opportunity as lost with a short reason (budget, timing, competitor, no response, ...), which reports use to learn. Use it when the prospect declined or went silent after the meeting. For a later retry, create a follow-up task with manage_tasks. The CRM is updated automatically.",
  effect: "write",
  input: z.object({
    opportunity_id: idSchema("opp"),
    lost_reason: z.string().min(1).max(500),
    notes: z.string().max(4000).optional(),
  }),
  output: changeOutput,
  http: { method: "POST", path: "/v1/opportunities/:opportunity_id/lost" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Lost to timing",
      input: { opportunity_id: OPPORTUNITY_EXAMPLE_ID, lost_reason: "timing" },
    },
  ],
  handler: (ctx, input) =>
    change(ctx, input.opportunity_id, {
      stage: "lost",
      lost_reason: input.lost_reason,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    }),
});

export const opportunityOperations = [
  listOpportunities,
  createOpportunityOperation,
  updateOpportunityOperation,
  wonOpportunity,
  lostOpportunity,
];
