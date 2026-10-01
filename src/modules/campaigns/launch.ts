import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { requireWorkspace } from "../../core/context.js";
import { isOpenOutboundError } from "../../core/errors.js";
import { askToChangeSetting } from "../../core/setting-hints.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import {
  automation_rules,
  campaigns,
  enrollments,
  linkedin_accounts,
  type Mailbox,
  mailboxes,
  offers,
  saved_searches,
} from "../../db/schema/index.js";
import { usesSandboxProviders } from "../../runtime/providers.js";
import {
  hasPublicBaseUrl,
  mailboxRampOutlook,
  PUBLIC_BASE_URL_FIX,
  readsReplies,
  SENDABLE_STATUSES,
  usesSandboxTransport,
} from "../email/service.js";
import { IN_PROGRESS } from "./control.js";
import { type LoadedCampaign, loadCampaign } from "./repo.js";
import { isLinkedInStep, stepUsesAi, validateSteps } from "./steps.js";

export interface ChecklistItem {
  key: string;
  label: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  /** What to do when it is not a pass (tool, action and field). */
  fix?: string;
}

export interface LaunchEstimates {
  queued: number;
  in_progress: number;
  daily_new_leads: number;
  email_steps: number;
  linkedin_steps: number;
  ai_steps: number;
  est_daily_emails: number;
  mailbox_daily_capacity: number;
  /**
   * Rough AI cost per lead for the whole sequence (writing + checking), in USD; 0 in a sandbox
   * workspace, whose fake AI brain costs nothing.
   */
  est_ai_cost_usd_per_lead: number;
}

export interface LaunchChecklist {
  ready: boolean;
  items: ChecklistItem[];
  estimates: LaunchEstimates;
}

/** Rough cost of one AI-written message (standard-tier draft + fast-tier check + rare rewrite). */
const AI_COST_PER_MESSAGE_USD = 0.012;

/** Rough AI cost per lead with a real AI brain (writing and checking every AI step), in USD. */
function aiCostPerLead(aiSteps: number): number {
  return Math.round(aiSteps * AI_COST_PER_MESSAGE_USD * 1000) / 1000;
}

/** Rough AI cost per day at the daily_new_leads pace with a real AI brain, in USD. */
export function dailyAiCostUsd(
  estimates: Pick<LaunchEstimates, "ai_steps" | "daily_new_leads">,
): number {
  return Math.round(aiCostPerLead(estimates.ai_steps) * estimates.daily_new_leads * 100) / 100;
}

/** Unsubscribe links and One-Click headers only work from a base URL recipients can reach. */
export function isPublicHttpsUrl(value: string): boolean {
  return hasPublicBaseUrl({ baseUrl: value });
}

function item(
  key: string,
  label: string,
  status: ChecklistItem["status"],
  detail: string,
  fix?: string,
): ChecklistItem {
  return fix && status !== "pass"
    ? { key, label, status, detail, fix }
    : { key, label, status, detail };
}

/**
 * Pre-launch checks with fixes: valid steps, active senders and their capacity, reply sync
 * (IMAP) on every sender mailbox, an offer or instructions to write from, an enrollment source,
 * compliance (postal address, a public https base URL for the unsubscribe link of real email),
 * a sane schedule, plus volume and AI cost estimates. `ready` is false when any item fails.
 */
export async function launchChecklist(
  ctx: OpContext,
  loaded: LoadedCampaign,
): Promise<LaunchChecklist> {
  const workspace = requireWorkspace(ctx);
  const workspaceSettings = parseWorkspaceSettings(workspace.settings);
  const { campaign, settings, steps } = loaded;
  const items: ChecklistItem[] = [];

  try {
    validateSteps(
      steps.map((step) => ({
        type: step.type,
        delay_days: step.delay_days,
        delay_hours: step.delay_hours,
        config: step.config as Record<string, unknown>,
      })),
    );
    items.push(item("steps_valid", "Steps are valid", "pass", `${steps.length} step(s).`));
  } catch (error) {
    items.push(
      item(
        "steps_valid",
        "Steps are valid",
        "fail",
        isOpenOutboundError(error) ? error.message : "The steps could not be validated.",
        "Fix the steps with create_campaign action update (steps).",
      ),
    );
  }

  const emailSteps = steps.filter((step) => step.type === "email");
  const linkedinSteps = steps.filter((step) => isLinkedInStep(step.type));
  const aiSteps = steps.filter((step) => stepUsesAi(step));
  if (emailSteps.length + linkedinSteps.length === 0) {
    items.push(
      item(
        "channel_steps",
        "Has email or LinkedIn steps",
        "warn",
        "No step contacts anyone; only tasks, waits or webhooks will run.",
        "Add an email or LinkedIn step with create_campaign action update.",
      ),
    );
  }

  let mailboxCapacity = 0;
  let senderRows: Mailbox[] = [];
  if (emailSteps.length > 0) {
    const ids = settings.senders.mailbox_ids;
    const rows =
      ids.length === 0
        ? []
        : await ctx.db
            .select()
            .from(mailboxes)
            .where(and(eq(mailboxes.workspace_id, workspace.id), inArray(mailboxes.id, ids)));
    senderRows = rows;
    const usable = rows.filter((row) =>
      (SENDABLE_STATUSES as readonly string[]).includes(row.status),
    );
    mailboxCapacity = usable.reduce((sum, row) => sum + row.daily_limit, 0);
    items.push(
      usable.length > 0
        ? item("mailboxes", "Active mailboxes", "pass", `${usable.length} active mailbox(es).`)
        : item(
            "mailboxes",
            "Active mailboxes",
            "fail",
            ids.length === 0
              ? "No mailbox is assigned to the campaign."
              : "None of the assigned mailboxes is active.",
            "List mailboxes with manage_mailboxes action list, then set settings.senders.mailbox_ids with create_campaign action update.",
          ),
    );
    if (usable.length > 0 && !workspace.is_sandbox) {
      // New domains get two quiet weeks (playbook section 4): launching works, sending waits.
      const outlooks = usable.map((row) =>
        mailboxRampOutlook(row, ctx.clock.now(), workspace.timezone),
      );
      if (outlooks.every((outlook) => outlook.today_limit === 0)) {
        const first = outlooks.map((outlook) => outlook.first_sending_day).sort()[0];
        items.push(
          item(
            "warmup",
            "Mailbox warm-up",
            "warn",
            `Every sender mailbox is still in its quiet warm-up weeks, so the first emails go out on ${first}. Launching now is fine: steps wait until then.`,
            "To send sooner, add a mailbox that is already warmed up with manage_mailboxes action add (warmed_up: true) and add it to settings.senders.mailbox_ids with create_campaign action update.",
          ),
        );
      }
    }
    if (rows.length > 0) {
      // Without IMAP, replies (and unsubscribes by reply) are never seen: stop rules cannot fire.
      const unread = rows.filter((row) => !readsReplies(workspace, row));
      items.push(
        unread.length === 0
          ? item(
              "reply_sync",
              "Replies are read",
              "pass",
              rows.every((row) => usesSandboxTransport(workspace, row))
                ? "Sandbox mailboxes: replies are simulated."
                : "Every sender mailbox has IMAP for replies, bounces and unsubscribes.",
            )
          : item(
              "reply_sync",
              "Replies are read",
              "fail",
              `No IMAP is configured for ${unread.map((row) => row.email).join(", ")}: replies would go unseen, so stop rules never fire and people who replied or unsubscribed by reply would keep getting steps.`,
              "Add the IMAP server with manage_mailboxes action update (imap_host, imap_port), or remove the mailbox from settings.senders.mailbox_ids with create_campaign action update.",
            ),
      );
    }
  }
  if (linkedinSteps.length > 0) {
    const ids = settings.senders.linkedin_account_ids;
    const rows =
      ids.length === 0
        ? []
        : await ctx.db
            .select({ status: linkedin_accounts.status })
            .from(linkedin_accounts)
            .where(
              and(
                eq(linkedin_accounts.workspace_id, workspace.id),
                inArray(linkedin_accounts.id, ids),
              ),
            );
    const usable = rows.filter((row) => row.status === "active");
    items.push(
      usable.length > 0
        ? item(
            "linkedin_accounts",
            "Active LinkedIn accounts",
            "pass",
            `${usable.length} active account(s).`,
          )
        : item(
            "linkedin_accounts",
            "Active LinkedIn accounts",
            "fail",
            ids.length === 0
              ? "No LinkedIn account is assigned to the campaign."
              : "None of the assigned LinkedIn accounts is active.",
            "Connect one with manage_linkedin, then set settings.senders.linkedin_account_ids with create_campaign action update.",
          ),
    );
  }

  const estDailyEmails = settings.daily_new_leads * emailSteps.length;
  if (emailSteps.length > 0 && mailboxCapacity > 0) {
    items.push(
      estDailyEmails <= mailboxCapacity
        ? item(
            "capacity",
            "Sending capacity",
            "pass",
            `About ${estDailyEmails} emails a day at steady state; mailboxes allow ${mailboxCapacity}.`,
          )
        : item(
            "capacity",
            "Sending capacity",
            "warn",
            `About ${estDailyEmails} emails a day at steady state but mailboxes allow ${mailboxCapacity}; sends will spread over more days.`,
            "Add mailboxes, or lower settings.daily_new_leads with create_campaign action update.",
          ),
    );
  }

  const exactOnly = aiSteps.length === 0;
  let offerOk = campaign.offer_id === null;
  if (campaign.offer_id) {
    const [offer] = await ctx.db
      .select({ status: offers.status })
      .from(offers)
      .where(and(eq(offers.id, campaign.offer_id), eq(offers.workspace_id, workspace.id)));
    offerOk = offer?.status === "active";
    items.push(
      offerOk
        ? item("offer", "Offer", "pass", "The offer is active.")
        : item(
            "offer",
            "Offer",
            "fail",
            "The campaign's offer is missing or archived.",
            "Pick an active offer (manage_knowledge action list_offers) and set offer_id with create_campaign action update.",
          ),
    );
  }
  const hasSource =
    exactOnly ||
    Boolean(campaign.offer_id && offerOk) ||
    settings.writing.instructions.trim() !== "";
  items.push(
    hasSource
      ? item(
          "content_source",
          "Something to write from",
          "pass",
          "Offer, instructions or exact templates are set.",
        )
      : item(
          "content_source",
          "Something to write from",
          "fail",
          "AI-written steps need an offer or writing instructions.",
          "Set offer_id or settings.writing.instructions with create_campaign action update.",
        ),
  );

  const [enrolledRow] = await ctx.db
    .select({ n: count() })
    .from(enrollments)
    .where(and(eq(enrollments.campaign_id, campaign.id), inArray(enrollments.status, IN_PROGRESS)));
  const [queuedRow] = await ctx.db
    .select({ n: count() })
    .from(enrollments)
    .where(and(eq(enrollments.campaign_id, campaign.id), eq(enrollments.status, "queued")));
  const inProgress = Number(enrolledRow?.n ?? 0);
  const queued = Number(queuedRow?.n ?? 0);
  let sources = inProgress;
  if (sources === 0) {
    const [searches] = await ctx.db
      .select({ n: count() })
      .from(saved_searches)
      .where(
        and(
          eq(saved_searches.workspace_id, workspace.id),
          eq(saved_searches.campaign_id, campaign.id),
        ),
      );
    const [rules] = await ctx.db
      .select({ n: count() })
      .from(automation_rules)
      .where(
        and(
          eq(automation_rules.workspace_id, workspace.id),
          sql`${automation_rules.actions}::text like ${`%${campaign.id}%`}`,
        ),
      );
    sources = Number(searches?.n ?? 0) + Number(rules?.n ?? 0);
  }
  items.push(
    sources > 0
      ? item(
          "enrollment_source",
          "Leads to contact",
          "pass",
          inProgress > 0
            ? `${inProgress} lead(s) enrolled.`
            : "A saved search or automation enrolls leads.",
        )
      : item(
          "enrollment_source",
          "Leads to contact",
          "warn",
          "Nobody is enrolled yet and no saved search or automation feeds this campaign.",
          "Enroll leads with enroll_leads action enroll (person_ids, list_id or filter).",
        ),
  );

  if (emailSteps.length > 0) {
    // Mandatory for cold email (CAN-SPAM, GDPR), whatever compliance.include_postal_address says.
    items.push(
      workspaceSettings.company.postal_address.trim()
        ? item("postal_address", "Postal address in the footer", "pass", "Set.")
        : item(
            "postal_address",
            "Postal address in the footer",
            "fail",
            "Every cold email must carry a postal address (CAN-SPAM, GDPR) and none is set.",
            askToChangeSetting({ "company.postal_address": "<postal address>" }),
          ),
    );
    // Real email needs a working unsubscribe link: the send job holds it without one.
    const baseUrl = ctx.config.baseUrl;
    const simulated =
      senderRows.length > 0 && senderRows.every((row) => usesSandboxTransport(workspace, row));
    items.push(
      workspace.is_sandbox || simulated
        ? item(
            "unsubscribe_link",
            "Unsubscribe link",
            "pass",
            "Sandbox: unsubscribe links are simulated.",
          )
        : hasPublicBaseUrl(ctx.config)
          ? item(
              "unsubscribe_link",
              "Unsubscribe link",
              "pass",
              `Every email links to an unsubscribe page and a One-Click header on ${baseUrl}.`,
            )
          : item(
              "unsubscribe_link",
              "Unsubscribe link",
              "fail",
              `OPENOUTBOUND_BASE_URL (${baseUrl}) is not a public https address, so the unsubscribe link in every email would not work. Emails of this campaign would be held until it is set.`,
              PUBLIC_BASE_URL_FIX,
            ),
    );
  }
  if (!workspaceSettings.company.name.trim()) {
    items.push(
      item(
        "company_name",
        "Sender company name",
        "warn",
        "The workspace has no company name; emails and footers read better with one.",
        askToChangeSetting({ "company.name": "<company name>" }),
      ),
    );
  }
  const schedule = settings.schedule;
  items.push(
    schedule.days.length > 0 && schedule.start_hour < schedule.end_hour
      ? item(
          "schedule",
          "Sending window",
          "pass",
          `Days ${schedule.days.join(",")}, ${schedule.start_hour}:00-${schedule.end_hour}:00 ${schedule.timezone_mode === "lead" ? "in each lead's timezone" : schedule.timezone}.`,
        )
      : item(
          "schedule",
          "Sending window",
          "fail",
          "The schedule has no days or start_hour is not before end_hour.",
          "Fix settings.schedule with create_campaign action update.",
        ),
  );
  if (aiSteps.length > 0) {
    let brain: unknown = null;
    try {
      brain = await ctx.providers.tryGet("brain");
    } catch {
      brain = null;
    }
    if (!brain && !workspace.is_sandbox) {
      items.push(
        item(
          "brain",
          "AI brain",
          "warn",
          "No AI brain is configured for this workspace, so AI-written steps wait (nothing is sent or failed) until one is.",
          "Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in the engine's .env and restart `openoutbound serve`, or store a key with manage_providers action set (slot brain). Exact templates need no brain.",
        ),
      );
    }
  }
  if (workspace.status !== "active") {
    items.push(
      item(
        "workspace_active",
        "Workspace is running",
        "warn",
        "The workspace is paused; nothing is sent until it resumes.",
        "Resume it with manage_workspaces action resume.",
      ),
    );
  }

  return {
    ready: !items.some((entry) => entry.status === "fail"),
    items,
    estimates: {
      queued,
      in_progress: inProgress,
      daily_new_leads: settings.daily_new_leads,
      email_steps: emailSteps.length,
      linkedin_steps: linkedinSteps.length,
      ai_steps: aiSteps.length,
      est_daily_emails: estDailyEmails,
      mailbox_daily_capacity: mailboxCapacity,
      est_ai_cost_usd_per_lead: usesSandboxProviders(workspace, "brain")
        ? 0
        : aiCostPerLead(aiSteps.length),
    },
  };
}

export interface ActivateResult {
  launched: boolean;
  status: string;
  reason?: string;
  checklist?: LaunchChecklist;
}

/** Launches (or resumes launching) a campaign after the checklist passes; emits campaign.launched. */
export async function activateCampaign(
  ctx: OpContext,
  campaignId: string,
): Promise<ActivateResult> {
  const workspace = requireWorkspace(ctx);
  const loaded = await loadCampaign(ctx, campaignId);
  const { campaign } = loaded;
  if (campaign.status === "active") return { launched: true, status: "active" };
  if (campaign.status === "completed" || campaign.status === "archived") {
    return {
      launched: false,
      status: campaign.status,
      reason: `the campaign is ${campaign.status}`,
    };
  }
  const checklist = await launchChecklist(ctx, loaded);
  if (!checklist.ready) {
    return {
      launched: false,
      status: campaign.status,
      reason: checklist.items
        .filter((entry) => entry.status === "fail")
        .map((entry) => `${entry.label}: ${entry.detail}`)
        .join("; "),
      checklist,
    };
  }
  const now = ctx.clock.now();
  const updated = await ctx.db
    .update(campaigns)
    .set({ status: "active", launched_at: campaign.launched_at ?? now })
    .where(
      and(
        eq(campaigns.id, campaign.id),
        eq(campaigns.workspace_id, workspace.id),
        inArray(campaigns.status, ["draft", "paused"]),
      ),
    )
    .returning({ id: campaigns.id });
  if (updated.length > 0) {
    await ctx.events.emit("campaign.launched", {
      subject: { type: "campaign", id: campaign.id },
      data: { campaign_id: campaign.id, name: campaign.name },
    });
  }
  return { launched: true, status: "active", checklist };
}
