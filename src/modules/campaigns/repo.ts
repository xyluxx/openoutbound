import { and, asc, eq } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { requireWorkspace } from "../../core/context.js";
import { notFound } from "../../core/errors.js";
import { type CampaignSettings, parseCampaignSettings } from "../../core/settings.js";
import type { Db } from "../../db/client.js";
import {
  type Campaign,
  type CampaignStep,
  campaign_steps,
  campaigns,
  type Enrollment,
  enrollments,
  type Message,
  messages,
} from "../../db/schema/index.js";

/** A campaign with its parsed settings and ordered steps. */
export interface LoadedCampaign {
  campaign: Campaign;
  settings: CampaignSettings;
  steps: CampaignStep[];
}

/** The campaign in the context workspace, or `not_found`. */
export async function getCampaign(ctx: OpContext, campaignId: string): Promise<Campaign> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspace_id, workspace.id)));
  if (!row) throw notFound("Campaign", campaignId);
  return row;
}

export async function getSteps(db: Db, campaignId: string): Promise<CampaignStep[]> {
  return db
    .select()
    .from(campaign_steps)
    .where(eq(campaign_steps.campaign_id, campaignId))
    .orderBy(asc(campaign_steps.position));
}

export async function loadCampaign(ctx: OpContext, campaignId: string): Promise<LoadedCampaign> {
  const campaign = await getCampaign(ctx, campaignId);
  return {
    campaign,
    settings: parseCampaignSettings(campaign.settings),
    steps: await getSteps(ctx.db, campaign.id),
  };
}

export async function getEnrollment(ctx: OpContext, enrollmentId: string): Promise<Enrollment> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.workspace_id, workspace.id)));
  if (!row) throw notFound("Enrollment", enrollmentId);
  return row;
}

export async function findMessage(ctx: OpContext, messageId: string): Promise<Message | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspace_id, workspace.id)));
  return row ?? null;
}

export async function getMessage(ctx: OpContext, messageId: string): Promise<Message> {
  const row = await findMessage(ctx, messageId);
  if (!row) throw notFound("Message", messageId);
  return row;
}
