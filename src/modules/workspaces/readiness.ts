/**
 * Sending readiness: can this workspace reach a real person, per channel, and if not, what
 * exactly stops it. `workspaces.readiness` returns it, get_status shows it as `sending` and
 * `openoutbound doctor` prints it. It reads stored state only: no provider is called.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { REPLY_CATEGORIES, REVIEW_LEVELS, type ReviewLevel } from "../../core/enums.js";
import { defineOperation } from "../../core/operation.js";
import {
  parseCampaignSettings,
  parseWorkspaceSettings,
  type WorkspaceSettings,
} from "../../core/settings.js";
import {
  type Campaign,
  type CampaignStep,
  campaign_steps,
  campaigns,
  type LinkedInAccount,
  linkedin_accounts,
  type Mailbox,
  type MailboxDnsCheck,
  mailboxes,
  messages,
  sender_counters,
  type Workspace,
} from "../../db/schema/index.js";
import { pendingApprovalCounts } from "../../runtime/approvals.js";
import { kernelOf } from "../../runtime/context.js";
import { type ProviderHealthView, readProviderHealth } from "../../runtime/provider-health.js";
import { resolveSlot } from "../../runtime/providers.js";
import { stepChannel, stepUsesAi } from "../campaigns/service.js";
import {
  hasPublicBaseUrl,
  mailboxRampOutlook,
  PUBLIC_BASE_URL_FIX,
  readsReplies,
  SENDABLE_STATUSES,
  usesSandboxTransport,
} from "../email/service.js";

const readinessItem = z.object({
  id: z.string().describe("Stable id, e.g. base_url or mailbox_not_tested"),
  label: z.string(),
  detail: z.string().describe("What is true now, in plain words"),
  fix: z.string().describe("The exact command or tool action that changes it"),
});

const channelReadiness = z.object({
  ready: z
    .boolean()
    .describe(
      "True when this channel can reach a real person now, campaign messages included: no blockers are left",
    ),
  replies_ready: z
    .boolean()
    .describe(
      "True when a reply to someone who wrote to you goes out on this channel once a person approves it (and automatic replies, when on), even while blockers stop campaign messages",
    ),
  replies: z
    .string()
    .describe("Whether replies go out on this channel and from which senders, or why not"),
  blockers: z
    .array(readinessItem)
    .describe("What the engine refuses or holds until it is fixed, in the order to fix it"),
  warnings: z
    .array(readinessItem)
    .describe("What does not stop a real send but slows it down or risks it"),
});

export const readinessOutput = z.object({
  workspace: z.string().describe("Workspace slug"),
  sandbox: z.boolean().describe("A sandbox workspace never sends anything for real"),
  summary: z
    .string()
    .describe(
      "Whether anything can reach a real person (campaign messages, replies), and if not, why",
    ),
  email: channelReadiness,
  linkedin: channelReadiness,
  review: z.object({
    level: z.enum(REVIEW_LEVELS).describe("Review level new campaigns start with"),
    summary: z.string().describe("Who approves what before it goes out, in plain words"),
  }),
});

export type ReadinessItem = z.output<typeof readinessItem>;
export type ChannelReadiness = z.output<typeof channelReadiness>;
export type SendingReadiness = z.output<typeof readinessOutput>;

type ChannelName = "email" | "linkedin";

/**
 * Every id readiness can list as a blocker: each one is something the engine refuses (a launch)
 * or holds (a send) until it is fixed. tests/e2e/readiness-enforced.test.ts proves each one.
 */
export const READINESS_BLOCKER_IDS = [
  "sandbox",
  "paused",
  "archived",
  "no_mailbox",
  "mailbox_not_sending",
  "reply_sync",
  "base_url",
  "postal_address",
  "linkedin_provider",
  "no_linkedin_account",
  "linkedin_not_active",
  "linkedin_paused",
  "brain",
  "nothing_to_send",
] as const;

/** Ids that are only ever warnings: the engine sends anyway. */
const WARNING_IDS = [
  "mailbox_not_tested",
  "warmup",
  "dns",
  "brain_paused",
  "brain_failing",
  "linkedin_failing",
] as const;

type ReadinessId = (typeof READINESS_BLOCKER_IDS)[number] | (typeof WARNING_IDS)[number];

/** Blockers that stop replies on their channel too (the others stop campaign messages only). */
const STOPS_REPLIES: ReadonlySet<ReadinessId> = new Set<ReadinessId>([
  "sandbox",
  "paused",
  "archived",
  "no_mailbox",
  "mailbox_not_sending",
  "linkedin_provider",
  "no_linkedin_account",
  "linkedin_not_active",
  "linkedin_paused",
]);

/** What waits to go out on one channel: launched campaigns and approved one-off messages. */
interface ChannelWork {
  /** Active campaigns with at least one step on this channel. */
  campaigns: number;
  /** One of those steps needs no AI (exact text, a visit, an invitation without a note). */
  plainSteps: boolean;
  /** Approved or scheduled messages that are not campaign steps (replies). */
  waiting: number;
}

function item(id: ReadinessId, label: string, detail: string, fix: string): ReadinessItem {
  return { id, label, detail, fix };
}

/**
 * Items for providers of a slot that are paused (calls stop until fixed) or failing (calls keep
 * failing), from their open `provider_down` or `brain_down` problems.
 */
function healthItems(
  health: Map<string, ProviderHealthView>,
  slot: "brain" | "linkedin",
  label: string,
): { paused: ReadinessItem[]; failing: ReadinessItem[] } {
  const paused: ReadinessItem[] = [];
  const failing: ReadinessItem[] = [];
  for (const view of health.values()) {
    if (view.slot !== slot || view.status === "ok") continue;
    const detail =
      view.status === "paused"
        ? `${view.title ?? `${view.provider} is paused`}: calls to it stop until it is fixed${view.until ? ` (a trial call at ${view.until.toISOString()})` : ""}, so nothing that needs it goes out meanwhile.`
        : slot === "brain"
          ? `${view.title ?? `The ${view.provider} brain is not working`}: the backup brain answers in its place when one is set (ai.fallback_provider); without one, work that needs the AI fails until it works again.`
          : `${view.title ?? `${view.provider} keeps failing`}: calls to it keep failing and are retried.`;
    const fix =
      view.fix ??
      `Check the ${view.provider} credentials with manage_providers action set, then manage_providers action test.`;
    (view.status === "paused" ? paused : failing).push(
      item(`${slot}_${view.status === "paused" ? "paused" : "failing"}`, label, detail, fix),
    );
  }
  return { paused, failing };
}

const SANDBOX_REPLIES = "Sandbox workspace: replies go to the simulator, never to a real person.";

/**
 * One channel's answer. Replies go out unless a blocker that stops replies too is listed
 * (STOPS_REPLIES); `repliesGo` says from which senders when they do.
 */
function channel(
  blockers: ReadinessItem[],
  warnings: ReadinessItem[],
  repliesGo: string,
): ChannelReadiness {
  const stop = blockers.find((entry) => STOPS_REPLIES.has(entry.id as ReadinessId));
  return {
    ready: blockers.length === 0,
    replies_ready: !stop,
    replies: !stop
      ? repliesGo
      : stop.id === "sandbox"
        ? SANDBOX_REPLIES
        : `Replies cannot go out either: ${stop.detail}`,
    blockers,
    warnings,
  };
}

/** Up to three names, then "and N more". */
function someNames(names: readonly string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** `openoutbound <command> --workspace <slug> <args>` in a code span. */
function commandFor(slug: string) {
  return (command: string, args = "") =>
    `\`openoutbound ${command} --workspace ${slug}${args ? ` ${args}` : ""}\``;
}

/**
 * Windows PowerShell 5.1 strips the double quotes inside an argument it passes to node, so a JSON
 * flag fails there as printed: the file form works in every shell.
 */
export function powershellJsonNote(flag: string, file: string): string {
  return `In Windows PowerShell 5.1, write that JSON to ${file} and pass ${flag} '@${file}' instead.`;
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const LEVEL_WORDS: Record<ReviewLevel, string> = {
  every: "A person approves every campaign message before it goes out.",
  first:
    "A person approves the first message each lead gets in a campaign; the later steps for that lead go out without review unless a check fails.",
  unsure:
    "A person approves only the campaign messages the automatic check is unsure about; the rest go out without review.",
};

/** The review rules in plain words: campaigns, replies and agent launches. */
export function reviewSummary(
  settings: WorkspaceSettings,
  active: ReadonlyArray<{ name: string; level: ReviewLevel }>,
): { level: ReviewLevel; summary: string } {
  const level = settings.approvals.default_review_level;
  const sentences = [LEVEL_WORDS[level]];
  const different = active.filter((campaign) => campaign.level !== level);
  if (different.length > 0) {
    const named = different
      .slice(0, 3)
      .map((campaign) => `"${campaign.name}" (${campaign.level})`)
      .join(", ");
    const more = different.length > 3 ? ` and ${different.length - 3} more` : "";
    sentences.push(`Active campaigns with their own review level: ${named}${more}.`);
  }
  sentences.push("A message that fails its automatic check always waits for a person.");
  const automatic = REPLY_CATEGORIES.filter(
    (category) => settings.replies[category].action === "auto_reply",
  );
  sentences.push(
    automatic.length === 0
      ? "Every reply the engine drafts waits for a person."
      : `Replies to ${listWords(automatic.map((category) => category.replaceAll("_", " ")))} messages go out without review when the check is confident; other drafted replies wait for a person.`,
  );
  sentences.push(
    settings.approvals.agent_launch_requires_approval
      ? "An agent's campaign launch waits for a person's approval."
      : "Agents can launch campaigns without a person's approval.",
  );
  return { level, summary: sentences.join(" ") };
}

/** Active campaigns and their steps, per channel, plus approved messages waiting outside them. */
async function waitingWork(
  ctx: OpContext,
  workspace: Workspace,
): Promise<{ work: Record<ChannelName, ChannelWork>; active: Campaign[] }> {
  const active = await ctx.db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.workspace_id, workspace.id),
        eq(campaigns.status, "active"),
        eq(campaigns.is_template, false),
      ),
    );
  const steps: CampaignStep[] =
    active.length === 0
      ? []
      : await ctx.db
          .select()
          .from(campaign_steps)
          .where(
            and(
              eq(campaign_steps.workspace_id, workspace.id),
              inArray(
                campaign_steps.campaign_id,
                active.map((campaign) => campaign.id),
              ),
            ),
          );
  const waiting = await ctx.db
    .select({ channel: messages.channel })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.direction, "outbound"),
        isNull(messages.step_id),
        inArray(messages.status, ["approved", "scheduled"]),
      ),
    )
    .limit(500);
  const work: Record<ChannelName, ChannelWork> = {
    email: { campaigns: 0, plainSteps: false, waiting: 0 },
    linkedin: { campaigns: 0, plainSteps: false, waiting: 0 },
  };
  for (const name of ["email", "linkedin"] as const) {
    const own = steps.filter((step) => stepChannel(step.type) === name);
    work[name].campaigns = new Set(own.map((step) => step.campaign_id)).size;
    work[name].plainSteps = own.some((step) => !stepUsesAi(step));
    work[name].waiting = waiting.filter((row) => row.channel === name).length;
  }
  return { work, active };
}

/** Problems in a stored DNS check, as short words (empty when SPF, DKIM and DMARC are fine). */
function dnsProblems(dns: MailboxDnsCheck): string[] {
  const words: string[] = [];
  for (const record of ["spf", "dkim", "dmarc"] as const) {
    const status = dns.statuses?.[record] ?? (dns[record] ? "green" : "red");
    if (status === "red") words.push(`${record.toUpperCase()} missing or broken`);
    else if (status === "yellow") words.push(`${record.toUpperCase()} needs a look`);
  }
  return words;
}

function domainOf(address: string): string {
  return address.slice(address.indexOf("@") + 1).toLowerCase();
}

/** Mailboxes that sent at least one email (proof that SMTP works). */
async function mailboxesThatSent(ctx: OpContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await ctx.db
    .selectDistinct({ id: sender_counters.sender_id })
    .from(sender_counters)
    .where(
      and(
        eq(sender_counters.sender_type, "mailbox"),
        eq(sender_counters.action, "email"),
        inArray(sender_counters.sender_id, ids),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

function smtpProven(mailbox: Mailbox, sent: Set<string>): boolean {
  return mailbox.health?.last_test?.smtp === "ok" || sent.has(mailbox.id);
}

function imapProven(mailbox: Mailbox): boolean {
  if (mailbox.health?.last_sync_error) return false;
  return mailbox.health?.last_test?.imap === "ok" || mailbox.last_synced_at !== null;
}

/** Why a mailbox has not proven both logins, in a few words. */
function untestedWords(mailbox: Mailbox, sent: Set<string>): string {
  const parts: string[] = [];
  const test = mailbox.health?.last_test;
  if (!smtpProven(mailbox, sent)) {
    parts.push(
      test?.smtp === "failed" ? "sending (SMTP) failed its test" : "sending (SMTP) not tested",
    );
  }
  if (!imapProven(mailbox)) {
    const error = mailbox.health?.last_sync_error;
    parts.push(
      error
        ? `reading replies (IMAP) fails: ${error.slice(0, 120)}`
        : test?.imap === "failed"
          ? "reading replies (IMAP) failed its test"
          : "reading replies (IMAP) not tested",
    );
  }
  return `${mailbox.email}: ${parts.join(", ")}`;
}

/**
 * The mailbox, base URL and postal address gates, plus warm-up and DNS. A launch-only gate (IMAP
 * on a sending mailbox, the postal address: the launch checklist checks them, the sender does
 * not) is a warning while an active campaign with email steps keeps sending anyway.
 */
async function emailReadiness(
  ctx: OpContext,
  workspace: Workspace,
  settings: WorkspaceSettings,
  work: ChannelWork,
  run: ReturnType<typeof commandFor>,
): Promise<{ blockers: ReadinessItem[]; warnings: ReadinessItem[]; sendable: Mailbox[] }> {
  const blockers: ReadinessItem[] = [];
  const warnings: ReadinessItem[] = [];
  const sending = work.campaigns > 0;
  /** A launch-only gate: blocks until a campaign is running, then only warns. */
  const launchGate = (entry: ReadinessItem) => (sending ? warnings : blockers).push(entry);
  const rows = await ctx.db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.workspace_id, workspace.id));
  const real = rows.filter((row) => !usesSandboxTransport(workspace, row));
  const sendable = real.filter((row) =>
    (SENDABLE_STATUSES as readonly string[]).includes(row.status),
  );
  const add = `Put MAILBOX_<NAME>_PASSWORD=<app password> in the engine's .env first and restart \`openoutbound serve\` (the engine reads it, not your shell), then ${run("mailboxes add", "--email <address> --preset google --password-env MAILBOX_<NAME>_PASSWORD --test")} (MCP: manage_mailboxes action add; Microsoft 365 connects with action oauth_start). It exits with code 1 when a login fails, and says which.`;
  if (real.length === 0) {
    const simulated = rows.length - real.length;
    blockers.push(
      item(
        "no_mailbox",
        "Mailbox connected",
        `No real mailbox is connected, so there is nothing to send email from${simulated > 0 ? ` (${simulated} sandbox mailbox${simulated === 1 ? "" : "es"} only send to the simulator)` : ""}.`,
        add,
      ),
    );
  } else if (sendable.length === 0) {
    const first = real[0] as Mailbox;
    blockers.push(
      item(
        "mailbox_not_sending",
        "Mailbox can send",
        `No mailbox can send: ${real
          .slice(0, 5)
          .map(
            (row) =>
              `${row.email} is ${row.status}${row.status_reason ? ` (${row.status_reason.slice(0, 120)})` : ""}`,
          )
          .join("; ")}.`,
        `Find the cause with ${run("mailboxes test", `--mailbox-id ${first.id}`)}, then ${run("mailboxes resume", `--mailbox-id ${first.id}`)} (MCP: manage_mailboxes actions test and resume).`,
      ),
    );
  } else {
    const reading = sendable.filter((row) => readsReplies(workspace, row));
    if (reading.length === 0) {
      const first = sendable[0] as Mailbox;
      const names = sendable
        .slice(0, 5)
        .map((row) => row.email)
        .join(", ");
      launchGate(
        item(
          "reply_sync",
          "Replies are read",
          sending
            ? `No sending mailbox has an IMAP server, so replies, bounces and unsubscribes by reply go unseen while active campaigns keep sending from ${names}. New campaigns with email steps cannot launch until one does.`
            : `No sending mailbox has an IMAP server, so replies, bounces and unsubscribes by reply would go unseen, and campaigns with email steps cannot launch: ${names}.`,
          `${run("mailboxes update", `--mailbox-id ${first.id} --imap-host <imap server>`)} (MCP: manage_mailboxes action update), then test it.`,
        ),
      );
    } else {
      const sent = await mailboxesThatSent(
        ctx,
        reading.map((row) => row.id),
      );
      const tested = reading.filter((row) => smtpProven(row, sent) && imapProven(row));
      if (tested.length === 0) {
        // A warning: the planner and the send job use any sendable mailbox, tested or not.
        const first = reading[0] as Mailbox;
        warnings.push(
          item(
            "mailbox_not_tested",
            "Mailbox tested",
            `No mailbox has passed a test of sending (SMTP) and reading replies (IMAP) yet: ${reading
              .slice(0, 5)
              .map((row) => untestedWords(row, sent))
              .join(
                "; ",
              )}. The engine still sends from a mailbox that was not tested (or whose test failed). Test it first, so a wrong password or server shows now instead of on the first real email, and so you know replies are read.`,
            `${run("mailboxes test", `--mailbox-id ${first.id}`)} (MCP: manage_mailboxes action test).`,
          ),
        );
      }
    }
  }
  if (!hasPublicBaseUrl(ctx.config)) {
    blockers.push(
      item(
        "base_url",
        "Public https address",
        `OPENOUTBOUND_BASE_URL is ${ctx.config.baseUrl}, which recipients cannot reach, so campaign emails would have no working unsubscribe link. Campaigns with email steps cannot launch and their emails are held until it is set. Replies to people who wrote to you still go out.`,
        PUBLIC_BASE_URL_FIX,
      ),
    );
  }
  if (!settings.company.postal_address.trim()) {
    launchGate(
      item(
        "postal_address",
        "Postal address",
        sending
          ? "Every cold email must carry a postal address (CAN-SPAM, GDPR) and none is set: active campaigns send their emails without one, and campaigns with email steps cannot launch until it is set."
          : "Every cold email must carry a postal address (CAN-SPAM, GDPR) and none is set, so campaigns with email steps cannot launch. Replies to people who wrote to you still go out.",
        `${run("workspaces update", `--settings '{"company":{"postal_address":"<postal address>"}}'`)} (an agent suggests it with manage_strategy action propose). ${powershellJsonNote("--settings", "settings.json")}`,
      ),
    );
  }

  if (sendable.length > 0) {
    const now = ctx.clock.now();
    const outlooks = sendable.map((row) => ({
      row,
      outlook: mailboxRampOutlook(row, now, workspace.timezone),
    }));
    if (outlooks.every((entry) => entry.outlook.today_limit === 0)) {
      const first = outlooks.map((entry) => entry.outlook.first_sending_day).sort()[0];
      warnings.push(
        item(
          "warmup",
          "Mailbox warm-up",
          `Every mailbox is in its quiet warm-up weeks, so the first emails go out on ${first}. Emails wait until then.`,
          `Nothing to do; to send sooner, add a mailbox that is already warmed up: ${run("mailboxes add", "--email <address> --preset google --password-env MAILBOX_<NAME>_PASSWORD --warmed-up --test")} (MCP: manage_mailboxes action add, warmed_up true).`,
        ),
      );
    } else {
      const ramping = outlooks.filter((entry) => entry.outlook.today_limit < entry.row.daily_limit);
      if (ramping.length > 0) {
        warnings.push(
          item(
            "warmup",
            "Mailbox warm-up",
            `Mailboxes still warming up send fewer emails a day: ${ramping
              .slice(0, 5)
              .map(
                (entry) =>
                  `${entry.row.email} ${entry.outlook.today_limit} of ${entry.row.daily_limit} today`,
              )
              .join(", ")}. The limit rises every week.`,
            `Nothing to do; see each mailbox's ramp with ${run("mailboxes list")} (MCP: manage_mailboxes action list).`,
          ),
        );
      }
    }
    const byDomain = new Map<string, Mailbox>();
    for (const row of sendable) {
      const domain = domainOf(row.email);
      if (!byDomain.has(domain)) byDomain.set(domain, row);
    }
    const unchecked: Mailbox[] = [];
    const problems: string[] = [];
    let firstProblem: Mailbox | null = null;
    for (const [domain, row] of byDomain) {
      if (!row.dns) {
        unchecked.push(row);
        continue;
      }
      const words = dnsProblems(row.dns);
      if (words.length > 0) {
        problems.push(`${domain}: ${words.join(", ")}`);
        firstProblem ??= row;
      }
    }
    if (problems.length > 0 || unchecked.length > 0) {
      const target = firstProblem ?? (unchecked[0] as Mailbox);
      const parts = [...problems];
      if (unchecked.length > 0) {
        parts.push(
          `not checked yet: ${unchecked
            .map((row) => domainOf(row.email))
            .slice(0, 5)
            .join(", ")}`,
        );
      }
      warnings.push(
        item(
          "dns",
          "SPF, DKIM and DMARC",
          `Sending domains without good SPF, DKIM and DMARC records land in spam or get refused (${parts.join("; ")}).`,
          `${run("mailboxes check-dns", `--mailbox-id ${target.id}`)} (MCP: manage_mailboxes action check_dns) shows each record and its exact fix.`,
        ),
      );
    }
  }
  return { blockers, warnings, sendable };
}

/** Where replies go out from on email, when nothing stops them. */
function emailRepliesGo(sendable: readonly Mailbox[], automatic: boolean): string {
  return `Replies to people who wrote to you go out once a person approves them (mailboxes that can send: ${someNames(sendable.map((row) => row.email))})${automatic ? ", and automatic replies go out on their own (auto_reply is on)" : ""}.`;
}

/** No LinkedIn provider resolves: accounts cannot connect and actions cannot go out. */
function linkedinProviderItem(run: ReturnType<typeof commandFor>): ReadinessItem {
  return item(
    "linkedin_provider",
    "LinkedIn provider",
    "No LinkedIn provider is configured for this workspace, so no LinkedIn account can be connected and no LinkedIn action can go out.",
    `Set UNIPILE_DSN and UNIPILE_API_KEY in the engine's .env and restart \`openoutbound serve\`, or store them for this workspace with ${run("providers set", `--slot linkedin --provider unipile --secrets '{"dsn":"<host:port>","api_key":"<your key>"}'`)} (MCP: manage_providers action set). ${powershellJsonNote("--secrets", "secrets.json")} docs/guides/linkedin.md explains the provider.`,
  );
}

function linkedinReadiness(
  accounts: LinkedInAccount[],
  run: ReturnType<typeof commandFor>,
): ReadinessItem[] {
  const real = accounts.filter((row) => row.provider !== "sandbox");
  if (real.length === 0) {
    return [
      item(
        "no_linkedin_account",
        "LinkedIn account connected",
        `No LinkedIn account is connected${accounts.length > 0 ? " (sandbox accounts only reach the simulator)" : ""}, so LinkedIn steps cannot run.`,
        `${run("linkedin accounts connect", "--accept-risk")} (MCP: manage_linkedin action connect), only after the account owner accepts that LinkedIn's terms forbid automation.`,
      ),
    ];
  }
  if (real.some((row) => row.status === "active")) return [];
  const first = real[0] as LinkedInAccount;
  const fix =
    first.status === "pending"
      ? "Open the login link from manage_linkedin action connect, then run manage_linkedin action sync."
      : `${run("linkedin accounts resume", `--account-id ${first.id}`)} (MCP: manage_linkedin action resume; a restricted account only after its owner cleared every check on LinkedIn).`;
  return [
    item(
      "linkedin_not_active",
      "LinkedIn account active",
      `No LinkedIn account is active: ${real
        .slice(0, 5)
        .map(
          (row) =>
            `${row.name ?? row.id} is ${row.status}${row.status_reason ? ` (${row.status_reason.slice(0, 120)})` : ""}`,
        )
        .join("; ")}.`,
      fix,
    ),
  ];
}

/** Where LinkedIn replies go out from, when nothing stops them. */
function linkedinRepliesGo(accounts: readonly LinkedInAccount[], automatic: boolean): string {
  const active = accounts.filter((row) => row.provider !== "sandbox" && row.status === "active");
  return `Replies to people who wrote to you on LinkedIn go out once a person approves them (active accounts: ${someNames(active.map((row) => row.name ?? row.id))})${automatic ? ", and automatic replies go out on their own (auto_reply is on)" : ""}.`;
}

function nothingToSend(
  name: ChannelName,
  pending: number,
  run: ReturnType<typeof commandFor>,
): ReadinessItem {
  const words = name === "email" ? "email" : "LinkedIn";
  return item(
    "nothing_to_send",
    "Something to send",
    `No launched campaign has ${words} steps and no approved ${words} reply waits to go out, so nothing goes out until a campaign is launched or a reply is approved.${pending > 0 ? ` ${pending} approval${pending === 1 ? "" : "s"} wait for a decision.` : ""}`,
    `Launch a campaign with ${run("campaigns launch", "--campaign-id <campaign id>")} (MCP: launch_campaign action launch), and decide what waits with ${run("approvals list")} (MCP: review_items action list).`,
  );
}

/**
 * A few plain sentences for the whole workspace. It never says that nothing can reach a real
 * person while replies can: a channel whose campaign messages are blocked but whose replies go
 * out is named as such.
 */
function summarize(workspace: Workspace, email: ChannelReadiness, linkedin: ChannelReadiness) {
  if (workspace.is_sandbox) {
    return "Sandbox workspace: nothing it does ever reaches a real person. Use a real workspace to send for real.";
  }
  const first = (readiness: ChannelReadiness) =>
    readiness.blockers[0]?.detail.split(/(?<=[.:])\s/)[0]?.replace(/[:.]$/, "") ?? "";
  if (email.ready && linkedin.ready) return "Email and LinkedIn can reach real people.";
  const replyChannels = [
    !email.ready && email.replies_ready ? "by email" : null,
    !linkedin.ready && linkedin.replies_ready ? "on LinkedIn" : null,
  ].filter((words): words is string => words !== null);
  const replies =
    replyChannels.length > 0
      ? ` Replies you approve still go out ${replyChannels.join(" and ")}.`
      : "";
  const emailName = email.replies_ready ? "Campaign email" : "Email";
  const linkedinName = linkedin.replies_ready ? "LinkedIn campaign steps" : "LinkedIn";
  if (email.ready) {
    return `Email can reach real people. ${linkedinName} cannot: ${first(linkedin)}.${replies}`;
  }
  if (linkedin.ready) {
    return `LinkedIn can reach real people. ${emailName} cannot: ${first(email)}.${replies}`;
  }
  const head =
    replyChannels.length > 0
      ? "No campaign message can reach a real person yet."
      : "Nothing can reach a real person yet.";
  return `${head} Email: ${first(email)}. LinkedIn: ${first(linkedin)}.${replies}`;
}

/** Whether the workspace can reach a real person, per channel, and what to fix first. */
export async function sendingReadiness(
  ctx: OpContext,
  workspace: Workspace,
): Promise<SendingReadiness> {
  const settings = parseWorkspaceSettings(workspace.settings);
  const run = commandFor(workspace.slug);
  const { work, active } = await waitingWork(ctx, workspace);
  const review = reviewSummary(
    settings,
    active.map((campaign) => ({
      name: campaign.name,
      level: parseCampaignSettings(campaign.settings).review_level,
    })),
  );

  if (workspace.is_sandbox) {
    const sandbox = item(
      "sandbox",
      "Real workspace",
      "This is a sandbox workspace: its mailboxes, LinkedIn accounts and AI are simulated, so nothing it does ever reaches a real person.",
      '`openoutbound workspaces create --name "<company name>"` creates a real workspace; docs/getting-started/going-live.md lists every step to a real send.',
    );
    const email = channel([sandbox], [], SANDBOX_REPLIES);
    const linkedin = channel([{ ...sandbox }], [], SANDBOX_REPLIES);
    return {
      workspace: workspace.slug,
      sandbox: true,
      summary: summarize(workspace, email, linkedin),
      email,
      linkedin,
      review,
    };
  }

  const shared: ReadinessItem[] = [];
  if (workspace.status === "paused") {
    shared.push(
      item(
        "paused",
        "Workspace running",
        "Sending is paused for this workspace (the kill switch), so nothing goes out until it resumes.",
        `${run("workspaces resume")} once the reason for the pause is fixed (MCP: manage_workspaces action resume).`,
      ),
    );
  } else if (workspace.status === "archived") {
    shared.push(
      item(
        "archived",
        "Workspace running",
        "The workspace is archived, so nothing runs or goes out.",
        `${run("workspaces update", "--no-archived")} restores it.`,
      ),
    );
  }

  const [brain] = await resolveSlot(kernelOf(ctx), workspace, "brain");
  const linkedinProviders = await resolveSlot(kernelOf(ctx), workspace, "linkedin");
  const health = await readProviderHealth(ctx.db, workspace.id);
  // A brain that fails has a backup or waits: a warning. A paused LinkedIn provider stops
  // every LinkedIn action: a blocker.
  const brainHealth = healthItems(health, "brain", "AI brain working");
  const linkedinHealth = healthItems(health, "linkedin", "LinkedIn provider working");
  const pending = Object.values(await pendingApprovalCounts(ctx.db, workspace.id)).reduce(
    (sum, count) => sum + count,
    0,
  );
  const brainItem = brain
    ? null
    : item(
        "brain",
        "AI brain",
        "No AI brain is configured, so AI-written steps and reply drafts wait until one is.",
        `Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in the engine's .env and restart \`openoutbound serve\`, or store a key for this workspace with ${run("providers set", `--slot brain --provider anthropic --secrets '{"api_key":"<your key>"}'`)} (MCP: manage_providers action set, slot brain). ${powershellJsonNote("--secrets", "secrets.json")}`,
      );
  /**
   * The brain and waiting-work gates of one channel. A missing brain blocks while nothing waiting
   * can go out without AI (nothing waits yet, or only AI-written steps do); once an exact-text
   * step, a step that needs no writing or an approved reply waits, it goes out and the brain is a
   * warning.
   */
  const workGates = (name: ChannelName) => {
    const own = work[name];
    const blockers: ReadinessItem[] = [];
    const warnings: ReadinessItem[] = [];
    const something = own.campaigns + own.waiting > 0;
    const withoutAi = own.waiting > 0 || own.plainSteps;
    if (brainItem) {
      if (withoutAi) warnings.push(brainItem);
      else blockers.push(brainItem);
    } else {
      warnings.push(...brainHealth.paused, ...brainHealth.failing);
    }
    if (!something) blockers.push(nothingToSend(name, pending, run));
    return { blockers, warnings };
  };
  // Automatic replies need a brain to write them.
  const automatic =
    Boolean(brain) &&
    REPLY_CATEGORIES.some((category) => settings.replies[category].action === "auto_reply");

  const emailChecks = await emailReadiness(ctx, workspace, settings, work.email, run);
  const emailWork = workGates("email");
  const email = channel(
    [...shared, ...emailChecks.blockers, ...emailWork.blockers],
    [...emailChecks.warnings, ...emailWork.warnings],
    emailRepliesGo(emailChecks.sendable, automatic),
  );

  const accounts = await ctx.db
    .select()
    .from(linkedin_accounts)
    .where(eq(linkedin_accounts.workspace_id, workspace.id));
  const linkedinWork = workGates("linkedin");
  const linkedin = channel(
    [
      ...shared,
      ...(linkedinProviders.length > 0 ? [] : [linkedinProviderItem(run)]),
      ...linkedinReadiness(accounts, run),
      ...linkedinHealth.paused,
      ...linkedinWork.blockers,
    ],
    [...linkedinHealth.failing, ...linkedinWork.warnings],
    linkedinRepliesGo(accounts, automatic),
  );
  return {
    workspace: workspace.slug,
    sandbox: false,
    summary: summarize(workspace, email, linkedin),
    email,
    linkedin,
    review,
  };
}

export const workspaceReadiness = defineOperation({
  id: "workspaces.readiness",
  summary: "Can this workspace send for real, and if not, why",
  description:
    "Answers whether email and LinkedIn can reach a real person from this workspace, with every blocker (something the engine refuses or holds) and warning and the exact command or tool action that fixes each: not a sandbox, not paused, a mailbox that can send and read replies (a warning until it passed its SMTP and IMAP test), a public https base URL, a postal address, warm-up and DNS, a LinkedIn provider that is set and not paused, a connected LinkedIn account, an AI brain that works, a launched campaign or an approved reply, and the review level in plain words. replies_ready says whether replies a person approves still go out on a channel while blockers such as the base URL stop its campaign messages. Use it before going live and whenever nothing seems to go out; get_status shows the same answer as `sending`. It does not test logins or DNS again (run manage_mailboxes actions test and check_dns for fresh results), and a sandbox workspace is never ready.",
  effect: "read",
  input: z.object({}),
  output: readinessOutput,
  http: { method: "GET", path: "/v1/workspace/readiness" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Can we send for real yet?", input: {} }],
  handler: async (ctx) => sendingReadiness(ctx, requireWorkspace(ctx)),
});
