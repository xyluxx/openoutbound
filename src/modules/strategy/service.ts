/**
 * Strategy service: what other modules call. The functions that apply changes to workspace
 * settings, offers, ICPs and campaigns record them with `recordChange` (binding signature from
 * the upgrade plan), comparing the snapshots below.
 */
export { type RecordChangeInput, recordChange } from "./change-log.js";
export {
  type CampaignSnapshot,
  campaignSnapshot,
  type IcpSnapshot,
  icpSnapshot,
  type OfferSnapshot,
  offerSnapshot,
  withStableSteps,
} from "./snapshots.js";
