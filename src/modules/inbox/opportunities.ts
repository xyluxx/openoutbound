/**
 * Pipeline: interested -> meeting_booked -> won | lost. Every change emits
 * `opportunity.updated` (CRM sync listens to it); stage changes run their side effects
 * (person status, stop sequences on meetings and wins).
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { OpportunityStage } from "../../core/enums.js";
import { parseCampaignSettings } from "../../core/settings.js";
import {
  type Campaign,
  type Company,
  campaigns,
  messages,
  type NewOpportunity,
  type Opportunity,
  opportunities,
  type Person,
  people,
  signals,
  type Thread,
} from "../../db/schema/index.js";
import { stopEnrollmentsForPerson } from "../campaigns/service.js";
import { advancePersonStatus } from "./person-status.js";

export const OPEN_STAGES: readonly OpportunityStage[] = ["interested", "meeting_booked"];
const CLOSED_STAGES: readonly OpportunityStage[] = ["won", "lost"];

export interface OpportunityPatch {
  stage?: OpportunityStage;
  value?: number | null;
  currency?: string | null;
  meeting_at?: Date | null;
  lost_reason?: string | null;
  notes?: string | null;
  source_signal_keys?: string[];
}

export async function getOpportunity(ctx: OpContext, id: string): Promise<Opportunity | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.workspace_id, workspace.id), eq(opportunities.id, id)))
    .limit(1);
  return row ?? null;
}

/** The person's most recent open opportunity (interested or meeting_booked). */
export async function findOpenOpportunity(
  ctx: OpContext,
  personId: string,
): Promise<Opportunity | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.workspace_id, workspace.id),
        eq(opportunities.person_id, personId),
        inArray(opportunities.stage, [...OPEN_STAGES]),
      ),
    )
    .orderBy(desc(opportunities.created_at))
    .limit(1);
  return row ?? null;
}

/**
 * Signal keys behind the outreach that led to a reply: `why.signal_keys` (and keys of
 * `why.signal_ids`) of our sent messages in the thread or the same campaign.
 */
export async function collectSourceSignalKeys(
  ctx: OpContext,
  input: { personId: string; threadId?: string | null; campaignId?: string | null },
): Promise<string[]> {
  const workspace = requireWorkspace(ctx);
  const scope = [
    input.threadId ? eq(messages.thread_id, input.threadId) : undefined,
    input.campaignId ? eq(messages.campaign_id, input.campaignId) : undefined,
  ].filter((condition) => condition !== undefined);
  if (scope.length === 0) return [];
  const rows = await ctx.db
    .select({ why: messages.why })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.person_id, input.personId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        or(...scope),
      ),
    );
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const row of rows) {
    for (const key of row.why?.signal_keys ?? []) keys.add(key);
    for (const id of row.why?.signal_ids ?? []) ids.add(id);
  }
  if (ids.size > 0) {
    const found = await ctx.db
      .select({ key: signals.definition_key })
      .from(signals)
      .where(and(eq(signals.workspace_id, workspace.id), inArray(signals.id, [...ids])));
    for (const row of found) keys.add(row.key);
  }
  return [...keys].sort();
}

async function emitUpdated(
  ctx: OpContext,
  opportunity: Opportunity,
  previous: OpportunityStage | null,
): Promise<void> {
  await ctx.events.emit("opportunity.updated", {
    subject: { type: "opportunity", id: opportunity.id },
    data: {
      opportunity_id: opportunity.id,
      stage: opportunity.stage,
      previous_stage: previous,
      person_id: opportunity.person_id,
      company_id: opportunity.company_id,
    },
  });
}

async function campaignOf(ctx: OpContext, campaignId: string | null): Promise<Campaign | null> {
  if (!campaignId) return null;
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspace_id, workspace.id), eq(campaigns.id, campaignId)))
    .limit(1);
  return row ?? null;
}

async function personOf(ctx: OpContext, personId: string | null): Promise<Person | null> {
  if (!personId) return null;
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspace.id), eq(people.id, personId)))
    .limit(1);
  return row ?? null;
}

/** Side effects of entering a stage: person status and stop rules (campaign `stop` settings). */
async function applyStageEffects(ctx: OpContext, opportunity: Opportunity): Promise<string[]> {
  const effects: string[] = [];
  const person = await personOf(ctx, opportunity.person_id);
  if (!person) return effects;
  const stop = parseCampaignSettings(
    (await campaignOf(ctx, opportunity.campaign_id))?.settings,
  ).stop;
  if (opportunity.stage === "meeting_booked") {
    if (await advancePersonStatus(ctx, person, "meeting")) effects.push("person_status:meeting");
    if (stop.on_meeting) {
      await stopEnrollmentsForPerson(ctx, {
        personId: person.id,
        reason: "meeting_booked",
        companyWide: stop.on_company_reply,
      });
      effects.push("enrollments_stopped");
    }
  } else if (opportunity.stage === "won") {
    if (await advancePersonStatus(ctx, person, "customer")) effects.push("person_status:customer");
    await stopEnrollmentsForPerson(ctx, { personId: person.id, reason: "won", companyWide: true });
    effects.push("enrollments_stopped");
  } else if (opportunity.stage === "interested") {
    if (await advancePersonStatus(ctx, person, "interested")) {
      effects.push("person_status:interested");
    }
  }
  return effects;
}

/** Creates an opportunity, runs its stage effects and emits `opportunity.updated`. */
export async function createOpportunity(
  ctx: OpContext,
  values: Omit<NewOpportunity, "workspace_id" | "id">,
): Promise<{ opportunity: Opportunity; effects: string[] }> {
  const workspace = requireWorkspace(ctx);
  const stage = values.stage ?? "interested";
  const [row] = await ctx.db
    .insert(opportunities)
    .values({
      ...values,
      workspace_id: workspace.id,
      stage,
      closed_at: CLOSED_STAGES.includes(stage) ? ctx.clock.now() : null,
    })
    .returning();
  if (!row) throw new Error("createOpportunity: insert returned no row");
  const effects = await applyStageEffects(ctx, row);
  await emitUpdated(ctx, row, null);
  return { opportunity: row, effects };
}

/**
 * Applies a patch. A stage change sets or clears closed_at and runs the stage effects.
 * Emits `opportunity.updated` when anything changed. Returns the stored row.
 */
export async function updateOpportunity(
  ctx: OpContext,
  current: Opportunity,
  patch: OpportunityPatch,
): Promise<{ opportunity: Opportunity; changed: boolean; effects: string[] }> {
  const set: Partial<Opportunity> = {};
  if (patch.stage !== undefined && patch.stage !== current.stage) {
    set.stage = patch.stage;
    set.closed_at = CLOSED_STAGES.includes(patch.stage) ? ctx.clock.now() : null;
  }
  if (patch.value !== undefined && patch.value !== current.value) set.value = patch.value;
  if (patch.currency !== undefined && patch.currency !== current.currency) {
    set.currency = patch.currency;
  }
  if (
    patch.meeting_at !== undefined &&
    (patch.meeting_at?.getTime() ?? null) !== (current.meeting_at?.getTime() ?? null)
  ) {
    set.meeting_at = patch.meeting_at;
  }
  if (patch.lost_reason !== undefined && patch.lost_reason !== current.lost_reason) {
    set.lost_reason = patch.lost_reason;
  }
  if (patch.notes !== undefined && patch.notes !== current.notes) set.notes = patch.notes;
  if (patch.source_signal_keys !== undefined) {
    const merged = [...new Set([...current.source_signal_keys, ...patch.source_signal_keys])];
    if (merged.length !== current.source_signal_keys.length) set.source_signal_keys = merged.sort();
  }
  if (Object.keys(set).length === 0) return { opportunity: current, changed: false, effects: [] };
  const [row] = await ctx.db
    .update(opportunities)
    .set(set)
    .where(
      and(eq(opportunities.workspace_id, current.workspace_id), eq(opportunities.id, current.id)),
    )
    .returning();
  if (!row) throw new Error("updateOpportunity: row disappeared");
  const effects = set.stage ? await applyStageEffects(ctx, row) : [];
  await emitUpdated(ctx, row, current.stage);
  return { opportunity: row, changed: true, effects };
}

/**
 * Opportunity for a hot reply: reuses the person's open opportunity (adding the thread and
 * signal keys), else creates one at stage `interested`.
 */
export async function ensureOpportunityForReply(
  ctx: OpContext,
  input: {
    person: Person;
    company: Company | null;
    campaign: Campaign | null;
    thread: Thread | null;
    note: string;
  },
): Promise<{ opportunity: Opportunity; created: boolean }> {
  const keys = await collectSourceSignalKeys(ctx, {
    personId: input.person.id,
    threadId: input.thread?.id ?? null,
    campaignId: input.campaign?.id ?? null,
  });
  const existing = await findOpenOpportunity(ctx, input.person.id);
  if (existing) {
    const { opportunity } = await updateOpportunity(ctx, existing, { source_signal_keys: keys });
    if (!opportunity.thread_id && input.thread) {
      await ctx.db
        .update(opportunities)
        .set({ thread_id: input.thread.id })
        .where(eq(opportunities.id, opportunity.id));
      return { opportunity: { ...opportunity, thread_id: input.thread.id }, created: false };
    }
    return { opportunity, created: false };
  }
  const { opportunity } = await createOpportunity(ctx, {
    person_id: input.person.id,
    company_id: input.company?.id ?? input.person.company_id ?? null,
    campaign_id: input.campaign?.id ?? null,
    thread_id: input.thread?.id ?? null,
    stage: "interested",
    notes: input.note,
    source_signal_keys: keys,
  });
  return { opportunity, created: true };
}

/**
 * Moves a person's opportunity to `meeting_booked` with `meeting_at` for a booked meeting: the
 * given open opportunity, else the person's open one, else a new one (with the latest thread
 * and campaign of the person, or the ones passed). Stage effects run as for any stage change
 * (person status, sequence stops, CRM sync), and the meeting_booked effects run again for an
 * opportunity that was already there (a second meeting stops sequences started since).
 * `changed` is false when nothing changed.
 */
export async function bookOpportunityMeeting(
  ctx: OpContext,
  input: {
    person: Person;
    meetingAt: Date | null;
    source: string;
    opportunityId?: string | null;
    threadId?: string | null;
    campaignId?: string | null;
  },
): Promise<{ opportunity: Opportunity; created: boolean; changed: boolean }> {
  const given = input.opportunityId ? await getOpportunity(ctx, input.opportunityId) : null;
  const existing =
    given && given.person_id === input.person.id && OPEN_STAGES.includes(given.stage)
      ? given
      : await findOpenOpportunity(ctx, input.person.id);
  if (existing) {
    const { opportunity, changed } = await updateOpportunity(ctx, existing, {
      stage: "meeting_booked",
      ...(input.meetingAt ? { meeting_at: input.meetingAt } : {}),
    });
    // Already at meeting_booked, so no stage change ran the stage effects: a newly booked
    // meeting still stops the person's active sequences (stop.on_meeting). Repeat-safe.
    if (existing.stage === "meeting_booked") await applyStageEffects(ctx, opportunity);
    return { opportunity, created: false, changed };
  }
  const [latest] =
    input.threadId || input.campaignId
      ? []
      : await ctx.db
          .select({ id: messages.thread_id, campaign_id: messages.campaign_id })
          .from(messages)
          .where(
            and(
              eq(messages.workspace_id, requireWorkspace(ctx).id),
              eq(messages.person_id, input.person.id),
            ),
          )
          .orderBy(desc(messages.created_at))
          .limit(1);
  const threadId = input.threadId ?? latest?.id ?? null;
  const campaignId = input.campaignId ?? latest?.campaign_id ?? null;
  const keys = await collectSourceSignalKeys(ctx, {
    personId: input.person.id,
    threadId,
    campaignId,
  });
  const { opportunity } = await createOpportunity(ctx, {
    person_id: input.person.id,
    company_id: input.person.company_id,
    campaign_id: campaignId,
    thread_id: threadId,
    stage: "meeting_booked",
    meeting_at: input.meetingAt,
    notes: `Meeting booked (${input.source})`,
    source_signal_keys: keys,
  });
  return { opportunity, created: true, changed: true };
}
