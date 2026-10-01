/**
 * What the change log compares for each area: the fields that change what the engine does.
 * The functions that apply changes build a snapshot before and after and pass both to
 * `recordChange`; undo builds the current snapshot and sets the changed paths back.
 */
import type { Campaign, CampaignStep, Icp, Offer } from "../../db/schema/index.js";

export interface OfferSnapshot {
  name: string;
  summary: string;
  details: string;
  value_props: string[];
  cta: string | null;
  booking_url: string | null;
  /** "suggested" for drafts waiting for approval. */
  status: "active" | "archived" | "suggested";
  is_default: boolean;
  proof_item_ids: string[];
}

export function offerSnapshot(offer: Offer): OfferSnapshot {
  return {
    name: offer.name,
    summary: offer.summary,
    details: offer.details,
    value_props: offer.value_props,
    cta: offer.cta,
    booking_url: offer.booking_url,
    status: offer.suggested ? "suggested" : offer.status,
    is_default: offer.is_default,
    proof_item_ids: offer.proof_item_ids,
  };
}

export interface IcpSnapshot {
  name: string;
  description: string | null;
  /** Stored criteria (what was set, without defaults). */
  criteria: Record<string, unknown>;
  scoring: Record<string, unknown>;
  signal_keys: string[];
  is_default: boolean;
}

export function icpSnapshot(icp: Icp): IcpSnapshot {
  return {
    name: icp.name,
    description: icp.description,
    criteria: icp.criteria,
    scoring: icp.scoring,
    signal_keys: icp.signal_keys,
    is_default: icp.is_default,
  };
}

export interface StepSnapshot {
  id: string;
  type: CampaignStep["type"];
  delay_days: number;
  delay_hours: number;
  config: Record<string, unknown>;
}

export interface CampaignSnapshot {
  name: string;
  description: string | null;
  goal: Campaign["goal"];
  offer_id: string | null;
  icp_id: string | null;
  /** Stored settings (what was set, without defaults). */
  settings: Record<string, unknown>;
  steps: StepSnapshot[];
}

export function campaignSnapshot(campaign: Campaign, steps: CampaignStep[]): CampaignSnapshot {
  return {
    name: campaign.name,
    description: campaign.description,
    goal: campaign.goal,
    offer_id: campaign.offer_id,
    icp_id: campaign.icp_id,
    settings: campaign.settings as Record<string, unknown>,
    steps: [...steps]
      .sort((a, b) => a.position - b.position)
      .map((step) => ({
        id: step.id,
        type: step.type,
        delay_days: step.delay_days,
        delay_hours: step.delay_hours,
        config: step.config as Record<string, unknown>,
      })),
  };
}

function stepContent(steps: StepSnapshot[]): unknown {
  return JSON.stringify(steps.map(({ id: _id, ...content }) => content));
}

/**
 * The after snapshot to record: when the steps only got new ids (a draft's steps are stored
 * again on every update) the before steps are kept, so an unchanged sequence is not a change.
 */
export function withStableSteps(
  before: CampaignSnapshot,
  after: CampaignSnapshot,
): CampaignSnapshot {
  return stepContent(before.steps) === stepContent(after.steps)
    ? { ...after, steps: before.steps }
    : after;
}
