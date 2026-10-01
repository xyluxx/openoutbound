import { and, count, eq, gte, inArray, ne } from "drizzle-orm";
import { type ActorRef, actorRef, type OpContext, requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { type CampaignStep, enrollments, type Person, people } from "../../db/schema/index.js";
import { checkContactable } from "../leads/service.js";
import { IN_PROGRESS } from "./control.js";
import { displayName, loadPeople, type PersonWithCompany } from "./people.js";
import { loadCampaign } from "./repo.js";
import { requestStatsRefresh } from "./stats.js";
import { isChannelStep, stepChannel } from "./steps.js";

export const MAX_ENROLL_BATCH = 5000;
const MAX_SKIPPED_LISTED = 100;

export interface EnrollOutcome {
  campaign_id: string;
  /** Unique people asked for. */
  requested: number;
  /** New enrollments (queued). In a dry run: how many would be enrolled. */
  enrolled: number;
  skipped: number;
  /** Skip reason -> count. */
  by_reason: Record<string, number>;
  /** First 100 skipped people with their reasons. */
  skipped_people: Array<{ person_id: string; name: string | null; reasons: string[] }>;
  enrollment_ids: string[];
  dry_run: boolean;
}

/** Deterministic A/B seed for a person in a campaign (FNV-1a, 31 bits). */
export function variantSeed(campaignId: string, personId: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${campaignId}:${personId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & 0x7fffffff;
}

/** Data a step needs that the person lacks ("email", "linkedin_url"), or null. */
export function missingDataFor(step: Pick<CampaignStep, "type">, person: Person): string | null {
  const channel = stepChannel(step.type);
  if (channel === "email" && !person.email) return "email";
  if (channel === "linkedin" && !person.linkedin_url) return "linkedin_url";
  return null;
}

/**
 * Enrolls people with the compliance checks: already enrolled, one active campaign per person,
 * rest days after a finished campaign, contact cap per company (active enrollments), missing
 * data for the first channel step (per `missing_data`) and contactability of that channel.
 * Returns counts and per-person skip reasons; writes nothing when `dryRun`.
 */
export async function enrollPeople(
  ctx: OpContext,
  input: { campaignId: string; personIds: string[]; source?: string; dryRun?: boolean },
): Promise<EnrollOutcome> {
  const workspace = requireWorkspace(ctx);
  const compliance = parseWorkspaceSettings(workspace.settings).compliance;
  const { campaign, settings, steps } = await loadCampaign(ctx, input.campaignId);
  if (campaign.status === "completed" || campaign.status === "archived") {
    throw new OpenOutboundError(
      "conflict",
      `Campaign ${campaign.name} is ${campaign.status}; it takes no new enrollments.`,
      {
        hint: "Duplicate it with create_campaign action duplicate, or pick another campaign with get_campaigns.",
        details: { campaign_id: campaign.id, status: campaign.status },
      },
    );
  }
  const ids = [...new Set(input.personIds)];
  if (ids.length > MAX_ENROLL_BATCH) {
    throw new OpenOutboundError(
      "validation_failed",
      `Too many people in one call (${ids.length}); the limit is ${MAX_ENROLL_BATCH}.`,
      { hint: "Split the list, or enroll a list with list_id in several calls." },
    );
  }
  const dryRun = input.dryRun ?? false;
  const now = ctx.clock.now();
  const found = await loadPeople(ctx, ids);

  const [existing, activeElsewhere, resting, companyCounts] = await Promise.all([
    ids.length === 0
      ? []
      : ctx.db
          .select({ person_id: enrollments.person_id })
          .from(enrollments)
          .where(
            and(eq(enrollments.campaign_id, campaign.id), inArray(enrollments.person_id, ids)),
          ),
    ids.length === 0 || !compliance.one_active_campaign_per_person
      ? []
      : ctx.db
          .select({ person_id: enrollments.person_id })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.workspace_id, workspace.id),
              inArray(enrollments.person_id, ids),
              inArray(enrollments.status, IN_PROGRESS),
              ne(enrollments.campaign_id, campaign.id),
            ),
          ),
    ids.length === 0 || compliance.rest_days_after_campaign === 0
      ? []
      : ctx.db
          .select({ person_id: enrollments.person_id })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.workspace_id, workspace.id),
              inArray(enrollments.person_id, ids),
              inArray(enrollments.status, ["completed", "stopped", "failed"]),
              gte(
                enrollments.completed_at,
                new Date(now.getTime() - compliance.rest_days_after_campaign * 86_400_000),
              ),
            ),
          ),
    ctx.db
      .select({ company_id: people.company_id, n: count() })
      .from(enrollments)
      .innerJoin(people, eq(people.id, enrollments.person_id))
      .where(
        and(eq(enrollments.workspace_id, workspace.id), inArray(enrollments.status, IN_PROGRESS)),
      )
      .groupBy(people.company_id),
  ]);
  const enrolledHere = new Set(existing.map((row) => row.person_id));
  const busy = new Set(activeElsewhere.map((row) => row.person_id));
  const rest = new Set(resting.map((row) => row.person_id));
  const perCompany = new Map<string, number>();
  for (const row of companyCounts)
    if (row.company_id) perCompany.set(row.company_id, Number(row.n));

  const channelSteps = steps.filter((step) => isChannelStep(step.type));
  const accepted: PersonWithCompany[] = [];
  const skipped: Array<{ person_id: string; name: string | null; reasons: string[] }> = [];

  for (const personId of ids) {
    const record = found.get(personId);
    const reasons: string[] = [];
    if (!record) {
      skipped.push({ person_id: personId, name: null, reasons: ["not_found"] });
      continue;
    }
    const { person } = record;
    if (enrolledHere.has(personId)) reasons.push("already_enrolled");
    if (busy.has(personId)) reasons.push("active_in_other_campaign");
    if (rest.has(personId)) reasons.push("rest_period");
    const companyId = person.company_id;
    if (companyId && (perCompany.get(companyId) ?? 0) >= compliance.contact_cap_per_company) {
      reasons.push("company_cap_reached");
    }
    if (reasons.length === 0 && channelSteps.length > 0) {
      let checked = false;
      for (const step of channelSteps) {
        const missing = missingDataFor(step, person);
        if (missing) {
          if (settings.missing_data === "skip_lead") {
            reasons.push(`missing_data:${missing}`);
            checked = true;
            break;
          }
          continue;
        }
        const channel = stepChannel(step.type);
        if (channel) {
          const result = await checkContactable(ctx, { personId, channel });
          if (!result.ok) {
            const codes = result.reasons.length > 0 ? result.reasons : ["unknown"];
            reasons.push(...codes.map((code) => `not_contactable:${code}`));
          }
        }
        checked = true;
        break;
      }
      if (!checked) reasons.push("missing_data:all_channels");
    }
    if (reasons.length > 0) {
      skipped.push({ person_id: personId, name: displayName(person), reasons });
      continue;
    }
    accepted.push(record);
    if (companyId) perCompany.set(companyId, (perCompany.get(companyId) ?? 0) + 1);
  }

  const byReason: Record<string, number> = {};
  for (const entry of skipped) {
    for (const reason of entry.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
  }

  let enrollmentIds: string[] = [];
  if (!dryRun && accepted.length > 0) {
    const by: ActorRef =
      input.source && ctx.principal.type === "system"
        ? { type: "system", id: input.source, name: "Automation", via: ctx.principal.via }
        : actorRef(ctx.principal);
    const inserted = await ctx.db
      .insert(enrollments)
      .values(
        accepted.map(({ person }) => ({
          workspace_id: workspace.id,
          campaign_id: campaign.id,
          person_id: person.id,
          status: "queued" as const,
          current_step: 0,
          variant_seed: variantSeed(campaign.id, person.id),
          enrolled_by: by,
          enrolled_at: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: enrollments.id });
    enrollmentIds = inserted.map((row) => row.id);
    await requestStatsRefresh(ctx, [campaign.id]);
  }

  return {
    campaign_id: campaign.id,
    requested: ids.length,
    enrolled: dryRun ? accepted.length : enrollmentIds.length,
    skipped: skipped.length,
    by_reason: byReason,
    skipped_people: skipped.slice(0, MAX_SKIPPED_LISTED),
    enrollment_ids: enrollmentIds,
    dry_run: dryRun,
  };
}
