import { defineTool } from "../../core/operation.js";

export const tools = [
  defineTool({
    name: "get_campaigns",
    title: "Get campaigns",
    description:
      "Read campaigns: list (status and headline counters), get (steps, effective settings, fresh stats per step and A/B variant), templates (built-in and saved sequences to start from) and enrollments (who is in a campaign, their status, step and stop reasons). Use it to find ids and judge performance. It never changes anything; use create_campaign to edit and launch_campaign to start or stop.",
    toolset: "core",
    actions: {
      list: "campaigns.list",
      get: "campaigns.get",
      templates: "campaigns.templates",
      enrollments: "campaigns.enrollments",
    },
  }),
  defineTool({
    name: "create_campaign",
    title: "Create or edit campaigns",
    description:
      "Build campaigns: create (from a built-in template like signal_based_email_4 or from steps, with offer, senders, schedule, review level and writing instructions), update (settings are deep-merged; keep step ids when editing live campaigns), pick_winner (end an A/B test: keep one variant of an email step), duplicate, delete (drafts only, others are archived) and save_as_template. New campaigns are drafts and send nothing until launched with launch_campaign. Preview drafts first with preview_campaign.",
    toolset: "core",
    actions: {
      create: "campaigns.create",
      update: "campaigns.update",
      pick_winner: "campaigns.pick_winner",
      duplicate: "campaigns.duplicate",
      delete: "campaigns.delete",
      save_as_template: "campaigns.save_as_template",
    },
  }),
  defineTool({
    name: "preview_campaign",
    title: "Preview and teach campaign writing",
    description:
      "preview drafts one step for 1-10 sample leads with the full writing pipeline and returns subject, body, why (angle, sourced facts, signals) and the checker verdict; nothing is stored or sent. teach turns corrections (or edited drafts) into writing rules the campaign follows from then on. Use preview before launching and after changing instructions. It spends AI budget.",
    toolset: "core",
    actions: { preview: "campaigns.preview", teach: "campaigns.teach" },
  }),
  defineTool({
    name: "launch_campaign",
    title: "Launch, pause, resume, stop or archive campaigns",
    description:
      "launch starts a campaign (run it with dry_run: true first for the checklist with fixes; agents may get an approval id instead when the workspace requires approval), pause holds sending, resume continues, stop ends every running enrollment and completes the campaign, archive stops and hides it. Use pause for temporary holds; stop and archive cannot be undone. To stop all sending in the workspace, pause the workspace instead.",
    toolset: "core",
    actions: {
      launch: "campaigns.launch",
      pause: "campaigns.pause",
      resume: "campaigns.resume",
      stop: "campaigns.stop",
      archive: "campaigns.archive",
    },
  }),
  defineTool({
    name: "enroll_leads",
    title: "Enroll or remove leads",
    description:
      "enroll adds people (ids, a list or a filter) to a campaign as queued enrollments after compliance checks (one active campaign per person, rest days, company cap, missing data, suppressions and contactability) and reports skip reasons; unenroll stops people in a campaign. Run enroll with dry_run: true first to see who would be skipped and why. Queued people start at the campaign's daily_new_leads pace once it is active.",
    toolset: "core",
    actions: { enroll: "campaigns.enroll", unenroll: "campaigns.unenroll" },
  }),
  defineTool({
    name: "manage_messages",
    title: "Manage campaign messages",
    description:
      "list and get outbound campaign messages (drafts, pending reviews, scheduled, sent) with why and checks; update edits a message's subject or body before sending (the original is kept for teach; a new text from anyone but a person holding approve goes to a person's review, also after approval); regenerate rewrites a draft with an optional instruction; cancel drops one message so the sequence skips that step; resolve_unknown settles a send with an unknown outcome (status unknown: the engine could not tell whether it went out) as sent, resend or cancel after a person checked the Sent folder (a resend waits for a person's approval unless a person holding approve asks). Approve or reject pending reviews with review_items. Prospect replies are in list_threads.",
    toolset: "core",
    actions: {
      list: "messages.list",
      get: "messages.get",
      update: "messages.update",
      regenerate: "messages.regenerate",
      cancel: "messages.cancel",
      resolve_unknown: "messages.resolve_unknown",
    },
  }),
];
