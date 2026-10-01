import { describe, expect, it } from "vitest";
import { toolOperationIds } from "../../core/operation.js";
import { module } from "./index.js";

describe("inbox module registration", () => {
  const operations = module.operations ?? [];
  const ids = operations.map((operation) => operation.id);

  it("registers unique operations with /v1 routes", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "threads.list",
        "threads.get",
        "threads.update",
        "threads.classify",
        "threads.draft_reply",
        "threads.send_reply",
        "opportunities.list",
        "opportunities.create",
        "opportunities.update",
        "opportunities.won",
        "opportunities.lost",
        "tasks.list",
        "tasks.create",
        "tasks.complete",
        "tasks.skip",
        "meetings.create_webhook",
        "meetings.list",
        "meetings.get",
        "meetings.record",
        "meetings.reschedule",
        "meetings.cancel",
        "meetings.mark_held",
        "meetings.mark_no_show",
        "meetings.qualify",
        "crm.sync",
        "crm.facts",
        "crm.link",
        "crm.status",
        "crm.create_webhook",
      ]),
    );
    const routes = operations.map(
      (operation) => `${operation.http?.method} ${operation.http?.path}`,
    );
    expect(new Set(routes).size).toBe(routes.length);
    for (const operation of operations) expect(operation.http?.path).toMatch(/^\/v1\//);
  });

  it("points every tool action at a registered operation", () => {
    const tools = module.tools ?? [];
    expect(tools.map((tool) => `${tool.name}:${tool.toolset}`)).toEqual([
      "list_threads:core",
      "reply_to_thread:core",
      "manage_pipeline:core",
      "manage_meetings:core",
      "manage_tasks:core",
      "manage_crm:core",
    ]);
    for (const tool of tools) {
      for (const id of toolOperationIds(tool)) expect(ids).toContain(id);
    }
    const listThreads = tools.find((tool) => tool.name === "list_threads");
    if (!listThreads) throw new Error("list_threads missing");
    const effects = toolOperationIds(listThreads).map(
      (id) => operations.find((operation) => operation.id === id)?.effect,
    );
    expect(effects.every((effect) => effect === "read")).toBe(true);
  });

  it("registers jobs, event handlers, schedules, resolvers and the webhook routes", () => {
    expect(module.jobs?.map((job) => job.name)).toEqual([
      "inbox.classify",
      "inbox.draft_reply",
      "inbox.send_reply",
      "inbox.crm_sync",
      "inbox.crm_daily",
      "inbox.crm_forget_delete",
      "inbox.privacy_reminders",
      "inbox.extract_promises",
      "inbox.lead_file_daily",
      "meetings.assume_held",
    ]);
    expect(module.eventHandlers?.map((handler) => `${handler.event}>${handler.name}`)).toEqual([
      "reply.received>inbox.classify_reply",
      "message.sent>inbox.mark_answered",
      "opportunity.updated>inbox.sync_crm",
      "reply.classified>inbox.crm_reply",
      "message.sent>inbox.crm_message_sent",
      "meeting.booked>inbox.crm_meeting_booked",
      "meeting.rescheduled>inbox.crm_meeting_rescheduled",
      "meeting.cancelled>inbox.crm_meeting_cancelled",
      "meeting.no_show>inbox.crm_meeting_no_show",
      "meeting.held>inbox.crm_meeting_held",
      "lead.forgotten>inbox.crm_forget",
      "message.sent>inbox.promises_on_reply",
      "thread.taken_over>inbox.promises_on_takeover",
    ]);
    expect(module.schedules?.map((schedule) => `${schedule.name}:${schedule.job}`)).toEqual([
      "inbox.crm_daily:inbox.crm_daily",
      "inbox.privacy_reminders:inbox.privacy_reminders",
      "inbox.lead_file_daily:inbox.lead_file_daily",
      "meetings.assume_held:meetings.assume_held",
    ]);
    expect(
      module.schedules?.find((schedule) => schedule.name === "meetings.assume_held")?.cron,
    ).toBe("23 * * * *");
    expect(
      module.schedules?.find((schedule) => schedule.name === "inbox.lead_file_daily")?.cron,
    ).toBe("25 4 * * *");
    expect(module.schedules?.every((schedule) => schedule.perWorkspace)).toBe(true);
    expect(module.approvalResolvers?.map((resolver) => resolver.kind)).toEqual([
      "reply",
      "referral",
    ]);
    expect(module.httpRoutes).toHaveLength(2);
    expect(module.providers).toBeUndefined();
  });
});
