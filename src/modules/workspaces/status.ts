import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../core/context.js";
import { FAILURE_CLASSES } from "../../core/failures.js";
import { defineOperation, isoDateTime } from "../../core/operation.js";
import { askToChangeSetting, askToRaiseBudget } from "../../core/setting-hints.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import {
  agent_tasks,
  campaigns,
  icps,
  jobs,
  knowledge_gaps,
  knowledge_items,
  linkedin_accounts,
  mailboxes,
  offers,
  people,
  threads,
  webhook_deliveries,
  webhook_endpoints,
} from "../../db/schema/index.js";
import { SLOTS } from "../../providers/types.js";
import { pendingApprovalCounts } from "../../runtime/approvals.js";
import { kernelOf } from "../../runtime/context.js";
import {
  healthyView,
  type ProviderHealthView,
  readProviderHealth,
} from "../../runtime/provider-health.js";
import { resolveSlot } from "../../runtime/providers.js";
import { monthBounds, monthToDate } from "../../runtime/usage.js";
import { readinessOutput, sendingReadiness } from "./readiness.js";
import { toWorkspaceView, workspaceOutput } from "./schemas.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const checklistItem = z.object({
  key: z.string(),
  title: z.string(),
  done: z.boolean(),
  detail: z.string(),
  next_step: z.string().nullable(),
});

const warning = z.object({ code: z.string(), message: z.string(), hint: z.string() });

const providerHealth = z.object({
  status: z
    .enum(["ok", "paused", "failing"])
    .describe("ok; paused (calls stop until it is fixed); failing (calls fail but still go out)"),
  class: z.enum(FAILURE_CLASSES).nullable().describe("Failure class behind a pause or failure"),
  since: isoDateTime().nullable(),
  until: isoDateTime().nullable().describe("When one call tries again (quota pauses)"),
  fix: z.string().nullable().describe("What to do, naming the tool and action"),
});

function healthOutput(view: ProviderHealthView): z.input<typeof providerHealth> {
  return {
    status: view.status,
    class: view.class,
    since: view.since,
    until: view.until,
    fix: view.fix,
  };
}

export const statusOutput = z.object({
  workspace: workspaceOutput,
  ready: z
    .boolean()
    .describe(
      "True when every setup step is done (the engine is set up); whether anything can reach a real person is in sending",
    ),
  sending: readinessOutput.describe(
    "Whether email and LinkedIn can reach a real person, with blockers and fixes (same as workspaces.readiness)",
  ),
  setup: z.object({
    done: z.number(),
    total: z.number(),
    next_step: z.string().nullable().describe("The most useful thing to do next"),
    items: z.array(checklistItem),
  }),
  providers: z.array(
    z.object({
      slot: z.string(),
      configured: z.boolean(),
      provider: z.string().nullable(),
      source: z.string().nullable().describe("workspace | instance | env | sandbox"),
      health: providerHealth
        .nullable()
        .describe(
          "Provider health (null when nothing serves the slot); see provider_down problems",
        ),
    }),
  ),
  warnings: z.array(warning),
  attention: z.object({
    pending_approvals: z.number(),
    approvals_by_kind: z.record(z.string(), z.number()),
    threads_needing_attention: z.number(),
    open_knowledge_gaps: z.number(),
    open_agent_tasks: z.number(),
    failed_jobs_24h: z.number(),
  }),
  usage: z.object({
    month: z.string(),
    ai_cost_usd: z.number(),
    ai_budget_usd: z.number().nullable(),
    data_credits: z.number(),
    data_credit_budget: z.number().nullable(),
  }),
});

export const workspaceStatus = defineOperation({
  id: "workspaces.status",
  summary: "Setup checklist, health warnings and what needs attention",
  description:
    "Returns the setup checklist (company profile, AI brain, knowledge, offer, ICP, senders, leads, campaign) with the next step for each missing item, whether email and LinkedIn can reach a real person (sending, with blockers and fixes), which provider serves each slot, health warnings (paused senders, restricted LinkedIn accounts, budgets, failing jobs) and counts of things waiting for a human. Call it in a new workspace, after setup changes and when something looks misconfigured; in a running workspace a session starts with manage_strategy (action get) and get_operating_state. For the full list of items to review use get_attention_queue or review_items. Counts are cheap; it never calls external services.",
  effect: "read",
  input: z.object({}),
  output: statusOutput,
  http: { method: "GET", path: "/v1/status" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Where do we stand?", input: {} }],
  handler: async (ctx) => {
    const workspace = requireWorkspace(ctx);
    const kernel = kernelOf(ctx);
    const { db } = ctx;
    const ws = workspace.id;
    const settings = parseWorkspaceSettings(workspace.settings);
    const now = ctx.clock.now();
    const since24h = new Date(now.getTime() - DAY_MS);

    const [
      knowledgeCount,
      offerCount,
      icpCount,
      mailboxCount,
      linkedinCount,
      peopleCount,
      campaignCount,
      threadCount,
      gapCount,
      agentTaskCount,
      failedJobs,
      failedDeliveries,
    ] = await Promise.all([
      db.$count(
        knowledge_items,
        and(eq(knowledge_items.workspace_id, ws), eq(knowledge_items.status, "active")),
      ),
      db.$count(offers, and(eq(offers.workspace_id, ws), eq(offers.status, "active"))),
      db.$count(icps, eq(icps.workspace_id, ws)),
      db.$count(
        mailboxes,
        and(eq(mailboxes.workspace_id, ws), inArray(mailboxes.status, ["active", "warming"])),
      ),
      db.$count(
        linkedin_accounts,
        and(eq(linkedin_accounts.workspace_id, ws), eq(linkedin_accounts.status, "active")),
      ),
      db.$count(people, eq(people.workspace_id, ws)),
      db.$count(campaigns, and(eq(campaigns.workspace_id, ws), eq(campaigns.is_template, false))),
      db.$count(
        threads,
        and(
          eq(threads.workspace_id, ws),
          eq(threads.needs_attention, true),
          ne(threads.status, "closed"),
        ),
      ),
      db.$count(
        knowledge_gaps,
        and(eq(knowledge_gaps.workspace_id, ws), eq(knowledge_gaps.status, "open")),
      ),
      db.$count(agent_tasks, and(eq(agent_tasks.workspace_id, ws), eq(agent_tasks.status, "open"))),
      db.$count(
        jobs,
        and(eq(jobs.workspace_id, ws), eq(jobs.status, "failed"), gte(jobs.finished_at, since24h)),
      ),
      db
        .select({ id: webhook_deliveries.id })
        .from(webhook_deliveries)
        .innerJoin(webhook_endpoints, eq(webhook_endpoints.id, webhook_deliveries.endpoint_id))
        .where(
          and(
            eq(webhook_endpoints.workspace_id, ws),
            eq(webhook_deliveries.status, "failed"),
            gte(webhook_deliveries.updated_at, new Date(now.getTime() - 7 * DAY_MS)),
          ),
        )
        .limit(100),
    ]);

    const health = await readProviderHealth(db, ws);
    const providers = await Promise.all(
      SLOTS.map(async (slot) => {
        const [first] = await resolveSlot(kernel, workspace, slot);
        const view = first
          ? (health.get(`${slot}:${first.id}`) ?? healthyView(slot, first.id))
          : null;
        return {
          slot,
          configured: first !== undefined,
          provider: first?.id ?? null,
          source: first?.level ?? null,
          health: view ? healthOutput(view) : null,
        };
      }),
    );
    const brain = providers.find((entry) => entry.slot === "brain");

    const items: Array<z.input<typeof checklistItem>> = [
      {
        key: "company",
        title: "Company profile",
        done: Boolean(settings.company.name && settings.company.website),
        detail: settings.company.name
          ? `${settings.company.name}${settings.company.website ? ` (${settings.company.website})` : ""}`
          : "Company name and website are not set.",
        next_step: askToChangeSetting({
          "company.name": "<company name>",
          "company.website": "https://www.example.com",
          "company.postal_address": "<postal address>",
        }),
      },
      {
        key: "brain",
        title: "AI brain",
        done: Boolean(brain?.configured),
        detail: brain?.configured
          ? `Using ${brain.provider} (${brain.source}).`
          : "No AI brain is configured.",
        next_step:
          "Configure one: `openoutbound providers set --slot brain --provider anthropic` or set ANTHROPIC_API_KEY (manage_providers action set).",
      },
      {
        key: "knowledge",
        title: "Knowledge base",
        done: knowledgeCount > 0,
        detail: `${knowledgeCount} active knowledge items.`,
        next_step:
          "Draft it from the website with manage_knowledge action bootstrap_from_website, then review the suggestions.",
      },
      {
        key: "offer",
        title: "Offer",
        done: offerCount > 0,
        detail: `${offerCount} active offers.`,
        next_step: "Add what you sell with manage_knowledge action add_offer.",
      },
      {
        key: "icp",
        title: "Ideal customer profile",
        done: icpCount > 0,
        detail: `${icpCount} ICPs.`,
        next_step: "Describe who to target with manage_icp action create.",
      },
      {
        key: "senders",
        title: "Sender connected",
        done: mailboxCount + linkedinCount > 0,
        detail: `${mailboxCount} active mailboxes, ${linkedinCount} active LinkedIn accounts.`,
        next_step:
          "Connect a mailbox with manage_mailboxes action add (or a LinkedIn account with manage_linkedin).",
      },
      {
        key: "leads",
        title: "Leads",
        done: peopleCount > 0,
        detail: `${peopleCount} people.`,
        next_step: "Find leads with find_leads or import a list with import_leads.",
      },
      {
        key: "campaign",
        title: "Campaign",
        done: campaignCount > 0,
        detail: `${campaignCount} campaigns.`,
        next_step: "Create one with create_campaign, then preview it with preview_campaign.",
      },
    ];
    // Cold email must carry a postal address (CAN-SPAM); campaign email always includes it.
    items.push({
      key: "postal_address",
      title: "Postal address for email footers",
      done: settings.company.postal_address.trim() !== "",
      detail:
        settings.company.postal_address.trim() || "Not set (required by CAN-SPAM for cold email).",
      next_step: askToChangeSetting({ "company.postal_address": "<postal address>" }),
    });
    for (const item of items) if (item.done) item.next_step = null;
    const done = items.filter((item) => item.done).length;

    const warnings: Array<z.input<typeof warning>> = [];
    if (workspace.status === "paused") {
      warnings.push({
        code: "workspace_paused",
        message: "Sending is paused for this workspace.",
        hint: "Resume with manage_workspaces action resume once the cause is fixed.",
      });
    }
    for (const view of health.values()) {
      if (view.slot === "brain") continue;
      warnings.push({
        code: "provider_down",
        message: view.title ?? `${view.provider} (${view.slot}) is ${view.status}.`,
        hint: view.fix ?? "Check it with manage_providers action test.",
      });
    }
    if (!kernel.config.secretKey && kernel.config.database.kind !== "memory") {
      warnings.push({
        code: "secret_key_missing",
        message:
          "OPENOUTBOUND_SECRET_KEY is not set, so provider keys and mailbox passwords cannot be stored.",
        hint: "Run `openoutbound init` to generate one.",
      });
    }
    const troubledMailboxes = await db
      .select({ email: mailboxes.email, status: mailboxes.status, reason: mailboxes.status_reason })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspace_id, ws),
          inArray(mailboxes.status, ["paused", "error", "disconnected"]),
        ),
      )
      .limit(5);
    for (const mailbox of troubledMailboxes) {
      warnings.push({
        code: `mailbox_${mailbox.status}`,
        message: `Mailbox ${mailbox.email} is ${mailbox.status}${mailbox.reason ? `: ${mailbox.reason}` : "."}`,
        hint: "Check it with manage_mailboxes action test, fix the cause, then resume it.",
      });
    }
    const troubledAccounts = await db
      .select({
        name: linkedin_accounts.name,
        status: linkedin_accounts.status,
        reason: linkedin_accounts.status_reason,
      })
      .from(linkedin_accounts)
      .where(
        and(
          eq(linkedin_accounts.workspace_id, ws),
          inArray(linkedin_accounts.status, ["restricted", "disconnected"]),
        ),
      )
      .limit(5);
    for (const account of troubledAccounts) {
      warnings.push({
        code: `linkedin_${account.status}`,
        message: `LinkedIn account${account.name ? ` ${account.name}` : ""} is ${account.status}${account.reason ? `: ${account.reason}` : "."}`,
        hint: "Stop LinkedIn steps for this account and reconnect it with manage_linkedin.",
      });
    }
    const usage = await monthToDate(db, ctx.clock, ws);
    const aiBudget = settings.ai.monthly_budget_usd;
    const dataBudget = settings.data.monthly_credit_budget;
    if (aiBudget !== null && aiBudget > 0 && usage.aiCostUsd >= aiBudget * 0.8) {
      warnings.push({
        code: usage.aiCostUsd >= aiBudget ? "ai_budget_exceeded" : "ai_budget_80",
        message: `AI spend this month is $${usage.aiCostUsd.toFixed(2)} of $${aiBudget}.`,
        hint: `Use cheaper models (settings.ai.task_models), or ${askToRaiseBudget("ai.monthly_budget_usd")}.`,
      });
    }
    if (dataBudget !== null && dataBudget > 0 && usage.dataCredits >= dataBudget * 0.8) {
      warnings.push({
        code: usage.dataCredits >= dataBudget ? "data_budget_exceeded" : "data_budget_80",
        message: `Data credits this month: ${usage.dataCredits} of ${dataBudget}.`,
        hint: `Narrow searches before enriching, or ${askToRaiseBudget("data.monthly_credit_budget")}.`,
      });
    }
    if (failedJobs > 0) {
      warnings.push({
        code: "failed_jobs",
        message: `${failedJobs} background jobs failed in the last 24 hours.`,
        hint: "Inspect them with `openoutbound jobs list --status failed` and get_job.",
      });
    }
    if (failedDeliveries.length > 0) {
      warnings.push({
        code: "webhook_failures",
        message: `${failedDeliveries.length} webhook deliveries failed in the last 7 days.`,
        hint: "Check the endpoint with manage_webhooks action test.",
      });
    }

    const byKind = await pendingApprovalCounts(db, ws);
    const pending = Object.values(byKind).reduce((sum, count) => sum + count, 0);
    return {
      workspace: toWorkspaceView(workspace),
      ready: done === items.length,
      sending: await sendingReadiness(ctx, workspace),
      setup: {
        done,
        total: items.length,
        next_step: items.find((item) => !item.done)?.next_step ?? null,
        items,
      },
      providers,
      warnings,
      attention: {
        pending_approvals: pending,
        approvals_by_kind: byKind,
        threads_needing_attention: threadCount,
        open_knowledge_gaps: gapCount,
        open_agent_tasks: agentTaskCount,
        failed_jobs_24h: failedJobs,
      },
      usage: {
        month: monthBounds(now).from.toISOString().slice(0, 7),
        ai_cost_usd: Math.round(usage.aiCostUsd * 100) / 100,
        ai_budget_usd: aiBudget,
        data_credits: usage.dataCredits,
        data_credit_budget: dataBudget,
      },
    };
  },
});
