/**
 * inbox module: reply classification and the action matrix, reply drafting and sending,
 * opportunities, meetings (records, booking webhooks, the held sweep), tasks, promises from sent
 * replies, the daily lead file job, privacy request reminders and the CRM (sync by preference,
 * the facts door and its webhook, links, forget handling). CRM providers are registered in
 * `src/providers/crm/index.ts`, not here.
 */
import type { EngineModule } from "../../core/operation.js";
import {
  crmHandlers,
  crmJobs,
  crmOperations,
  crmRoutes,
  crmSchedules,
  crmTools,
} from "./crm-operations.js";
import {
  classifyJob,
  classifyOnReply,
  draftReplyJob,
  markAnsweredOnSend,
  sendReplyJob,
} from "./jobs.js";
import { meetingOperations } from "./meeting-operations.js";
import { createMeetingWebhook, meetingsWebhookRoute } from "./meetings.js";
import { assumeHeldJob, assumeHeldSchedule } from "./meetings-held-job.js";
import { opportunityOperations } from "./opportunity-operations.js";
import { privacyRemindersJob, privacyRemindersSchedule } from "./privacy-reminders.js";
import {
  extractPromisesJob,
  leadFileDailyJob,
  leadFileDailySchedule,
  promisesOnReplySent,
  promisesOnTakeover,
} from "./promises.js";
import { referralResolver } from "./referral.js";
import { replyResolver } from "./reply-approval.js";
import { takeoverOperations } from "./takeover-operations.js";
import { taskOperations } from "./task-operations.js";
import { threadOperations } from "./thread-operations.js";
import { inboxTools } from "./tools.js";

export const module: EngineModule = {
  name: "inbox",
  operations: [
    ...threadOperations,
    ...takeoverOperations,
    ...opportunityOperations,
    ...taskOperations,
    ...meetingOperations,
    createMeetingWebhook,
    ...crmOperations,
  ],
  tools: [...inboxTools, ...crmTools],
  jobs: [
    classifyJob,
    draftReplyJob,
    sendReplyJob,
    ...crmJobs,
    privacyRemindersJob,
    extractPromisesJob,
    leadFileDailyJob,
    assumeHeldJob,
  ],
  schedules: [...crmSchedules, privacyRemindersSchedule, leadFileDailySchedule, assumeHeldSchedule],
  eventHandlers: [
    classifyOnReply,
    markAnsweredOnSend,
    ...crmHandlers,
    promisesOnReplySent,
    promisesOnTakeover,
  ],
  approvalResolvers: [replyResolver, referralResolver],
  httpRoutes: [meetingsWebhookRoute, ...crmRoutes],
};
