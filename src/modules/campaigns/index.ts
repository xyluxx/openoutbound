import type { EngineModule } from "../../core/operation.js";
import { resolveUnknownOperation } from "../email/unknown-operations.js";
import {
  campaignLaunchResolver,
  enrollmentResolver,
  messageResolver,
  reviewLevelResolver,
} from "./approvals.js";
import { eventHandlers } from "./events.js";
import {
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  getCampaign,
  listCampaigns,
  listEnrollments,
  listTemplates,
  saveAsTemplate,
  updateCampaign,
} from "./operations/campaigns.js";
import { enrollLeads, unenrollLeads } from "./operations/enroll.js";
import {
  archiveCampaign,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  stopCampaign,
} from "./operations/lifecycle.js";
import {
  cancelMessage,
  getMessageOp,
  listMessages,
  regenerateMessage,
  updateMessage,
} from "./operations/messages.js";
import { pickWinner } from "./operations/pick-winner.js";
import { previewCampaign, teachCampaign } from "./operations/preview.js";
import { generateMessageJob } from "./sequencer/generate.js";
import { TICK_JOB, tickJob } from "./sequencer/tick.js";
import { refreshStatsJob } from "./stats.js";
import { tools } from "./tools.js";

export const module: EngineModule = {
  name: "campaigns",
  operations: [
    listCampaigns,
    getCampaign,
    createCampaign,
    updateCampaign,
    pickWinner,
    duplicateCampaign,
    deleteCampaign,
    listTemplates,
    saveAsTemplate,
    listEnrollments,
    previewCampaign,
    teachCampaign,
    launchCampaign,
    pauseCampaign,
    resumeCampaign,
    stopCampaign,
    archiveCampaign,
    enrollLeads,
    unenrollLeads,
    listMessages,
    getMessageOp,
    updateMessage,
    regenerateMessage,
    cancelMessage,
    resolveUnknownOperation,
  ],
  tools,
  jobs: [tickJob, generateMessageJob, refreshStatsJob],
  schedules: [{ name: "campaigns.tick", cron: "* * * * *", job: TICK_JOB, perWorkspace: true }],
  eventHandlers,
  approvalResolvers: [
    messageResolver,
    campaignLaunchResolver,
    enrollmentResolver,
    reviewLevelResolver,
  ],
};
