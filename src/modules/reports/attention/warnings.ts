import { asc, eq, sql } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { isOpenOutboundError } from "../../../core/errors.js";
import { askToRaiseBudget } from "../../../core/setting-hints.js";
import { linkedin_accounts, mailboxes, type Workspace } from "../../../db/schema/index.js";
import type { Slot } from "../../../providers/types.js";
import { settingsOf } from "../builders/common.js";
import { costTotals, utcMonthStart } from "../builders/costs.js";
import { rate } from "../metric.js";
import { rows, ts } from "../sql.js";
import { DAY_MS } from "../timezone.js";
import type { Severity, Warning } from "./schema.js";

/** Bounce thresholds (deliverability playbook, section 8): warn at 2%, the engine pauses above 3%. */
export const BOUNCE_WARN_PCT = 2;
export const BOUNCE_CRITICAL_PCT = 3;
export const BOUNCE_MIN_SENDS = 20;
/** Budget use that raises a warning (100% blocks spend). */
export const BUDGET_WARN_PCT = 80;
/** Built-in signal collectors that need no provider (spec 10). */
export const BUILTIN_COLLECTORS: ReadonlySet<string> = new Set([
  "website_changes",
  "job_boards",
  "news_gdelt",
  "rss",
  "tech_detect",
  "first_party",
]);

export interface WarningsResult {
  warnings: Warning[];
  /** Whether an AI brain resolves for the workspace (also used by the setup checklist). */
  brainConfigured: boolean;
}

function warning(
  code: string,
  severity: Severity,
  message: string,
  hint: string,
  target: { type: string; id: string } | null = null,
): Warning {
  return {
    code,
    severity,
    message,
    hint,
    target_type: target?.type ?? null,
    target_id: target?.id ?? null,
  };
}

/** Reply sync must fail this long (several sync runs) before it becomes a warning. */
const SYNC_FAILING_AFTER_MS = 30 * 60 * 1000;

/**
 * Health warnings (spec 11.12): paused workspace, paused or failing mailboxes, bounce spikes,
 * restricted LinkedIn accounts, providers missing for features in use, budgets above 80%.
 * Critical first.
 */
export async function collectWarnings(
  ctx: OpContext,
  workspace: Workspace,
  now: Date,
): Promise<WarningsResult> {
  const db = ctx.db;
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const [mailboxList, accountList, bounces, needs, month] = await Promise.all([
    db
      .select({
        id: mailboxes.id,
        email: mailboxes.email,
        status: mailboxes.status,
        status_reason: mailboxes.status_reason,
        health: mailboxes.health,
      })
      .from(mailboxes)
      .where(eq(mailboxes.workspace_id, workspace.id))
      .orderBy(asc(mailboxes.email)),
    db
      .select({
        id: linkedin_accounts.id,
        name: linkedin_accounts.name,
        status: linkedin_accounts.status,
        status_reason: linkedin_accounts.status_reason,
      })
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.workspace_id, workspace.id))
      .orderBy(asc(linkedin_accounts.created_at)),
    rows<{ mailbox_id: string; sent: number; bounced: number }>(
      db,
      sql`select m.mailbox_id, count(*)::int as sent,
          count(*) filter (where m.status = 'bounced')::int as bounced
        from messages m
        where m.workspace_id = ${workspace.id} and m.direction = 'outbound'
          and m.origin = 'engine' and m.channel = 'email' and m.status in ('sent', 'bounced')
          and m.sent_at >= ${ts(since)} and m.sent_at < ${ts(now)}
          and m.mailbox_id is not null
        group by 1`,
    ),
    rows<{
      linkedin_steps: boolean;
      posts_due: boolean;
      lead_sources: string[] | null;
      collectors: string[] | null;
    }>(
      db,
      sql`select
          exists (
            select 1 from campaigns c join campaign_steps s on s.campaign_id = c.id
            where c.workspace_id = ${workspace.id} and c.status = 'active'
              and s.type like 'linkedin%'
          ) as linkedin_steps,
          exists (
            select 1 from posts p
            where p.workspace_id = ${workspace.id} and p.status in ('approved', 'scheduled')
          ) as posts_due,
          (
            select array_agg(distinct ss.source) from saved_searches ss
            where ss.workspace_id = ${workspace.id} and ss.enabled
              and ss.source in ('apollo', 'google_maps')
          ) as lead_sources,
          (
            select array_agg(distinct collector) from monitors mo
            cross join lateral unnest(mo.collectors) as collector
            where mo.workspace_id = ${workspace.id} and mo.enabled
          ) as collectors`,
    ),
    costTotals(db, [workspace.id], [{ from: utcMonthStart(now), to: now }]),
  ]);

  const out: Warning[] = [];
  if (workspace.status === "paused") {
    out.push(
      warning(
        "workspace_paused",
        "critical",
        "The workspace is paused (kill switch): no emails or LinkedIn actions go out.",
        "Resume it with manage_workspaces (action resume) once it is safe to send again.",
        { type: "workspace", id: workspace.id },
      ),
    );
  }

  for (const mailbox of mailboxList) {
    const reason = mailbox.status_reason ? `: ${mailbox.status_reason}` : "";
    const target = { type: "mailbox", id: mailbox.id };
    if (mailbox.status === "error") {
      out.push(
        warning(
          "mailbox_error",
          "critical",
          `Mailbox ${mailbox.email} has an error${reason}.`,
          `Run manage_mailboxes (action test, mailbox_id ${mailbox.id}) to see the error, fix it, then resume the mailbox.`,
          target,
        ),
      );
    } else if (mailbox.status === "paused") {
      out.push(
        warning(
          "mailbox_paused",
          "warning",
          `Mailbox ${mailbox.email} is paused${reason}.`,
          `Fix the cause, then resume it with manage_mailboxes (action resume, mailbox_id ${mailbox.id}).`,
          target,
        ),
      );
    } else if (mailbox.status === "disconnected") {
      out.push(
        warning(
          "mailbox_disconnected",
          "warning",
          `Mailbox ${mailbox.email} is disconnected${reason}.`,
          "Reconnect it with manage_mailboxes (action oauth_start or update with new credentials).",
          target,
        ),
      );
    }
    // Reply sync (IMAP) failures do not stop sending, so say it loudly: replies, bounces and
    // unsubscribes by reply go unseen while it fails. One failed run is not worth a warning.
    const syncError = mailbox.health?.last_sync_error;
    const failingSince = Date.parse(mailbox.health?.sync_error_since ?? "");
    if (
      syncError &&
      mailbox.status !== "disconnected" &&
      (Number.isNaN(failingSince) || now.getTime() - failingSince >= SYNC_FAILING_AFTER_MS)
    ) {
      out.push(
        warning(
          "mailbox_sync_failing",
          "critical",
          `Replies to ${mailbox.email} are not being read: ${syncError}. Replies, bounces and unsubscribes by reply go unseen until this is fixed.`,
          `Run manage_mailboxes (action test, mailbox_id ${mailbox.id}) to see the IMAP error, fix the login or server, then check the next sync. Pause the mailbox with manage_mailboxes (action pause) if it cannot be fixed soon.`,
          target,
        ),
      );
    }
  }

  for (const row of bounces) {
    if (row.sent < BOUNCE_MIN_SENDS) continue;
    const bounceRate = rate(row.bounced, row.sent) ?? 0;
    if (bounceRate < BOUNCE_WARN_PCT) continue;
    const mailbox = mailboxList.find((candidate) => candidate.id === row.mailbox_id);
    out.push(
      warning(
        "bounce_spike",
        bounceRate > BOUNCE_CRITICAL_PCT ? "critical" : "warning",
        `${mailbox?.email ?? row.mailbox_id} bounced ${row.bounced} of ${row.sent} emails (${bounceRate}%) in the last 7 days.`,
        "Re-verify the list source (enrich_leads, verify_only) and slow down; the engine pauses a mailbox above 3%.",
        { type: "mailbox", id: row.mailbox_id },
      ),
    );
  }

  for (const account of accountList) {
    const reason = account.status_reason ? `: ${account.status_reason}` : "";
    const label = account.name ?? account.id;
    const target = { type: "linkedin_account", id: account.id };
    if (account.status === "restricted") {
      out.push(
        warning(
          "linkedin_restricted",
          "critical",
          `LinkedIn account ${label} is restricted${reason}. Its actions are paused.`,
          "Resolve the restriction in LinkedIn, wait a few days, then resume with manage_linkedin at lower limits.",
          target,
        ),
      );
    } else if (account.status === "disconnected") {
      out.push(
        warning(
          "linkedin_disconnected",
          "warning",
          `LinkedIn account ${label} is disconnected${reason}.`,
          "Reconnect it with manage_linkedin (action connect).",
          target,
        ),
      );
    }
  }

  const providerWarnings = await providerChecks(ctx, workspace, {
    linkedin:
      Boolean(needs[0]?.linkedin_steps) ||
      accountList.some((account) => account.status !== "disconnected"),
    social: Boolean(needs[0]?.posts_due),
    leadSources: needs[0]?.lead_sources ?? [],
    collectors: (needs[0]?.collectors ?? []).filter((name) => !BUILTIN_COLLECTORS.has(name)),
  });
  out.push(...providerWarnings.warnings);

  const settings = settingsOf(workspace);
  const spent = month.get(workspace.id)?.[0];
  const aiBudget = settings.ai.monthly_budget_usd;
  const dataBudget = settings.data.monthly_credit_budget;
  if (aiBudget && spent) {
    const used = rate(spent.ai_cost_usd, aiBudget) ?? 0;
    if (used >= BUDGET_WARN_PCT) {
      out.push(
        warning(
          "ai_budget",
          used >= 100 ? "critical" : "warning",
          `AI spend is at ${used}% of the monthly budget ($${spent.ai_cost_usd.toFixed(2)} of $${aiBudget.toFixed(2)}).`,
          used >= 100
            ? `AI calls are blocked until next month. If more spend is intended, ${askToRaiseBudget("ai.monthly_budget_usd")}.`
            : `Watch AI spend (get_report type costs), or ${askToRaiseBudget("ai.monthly_budget_usd")}.`,
          { type: "workspace", id: workspace.id },
        ),
      );
    }
  }
  if (dataBudget && spent) {
    const used = rate(spent.data_credits, dataBudget) ?? 0;
    if (used >= BUDGET_WARN_PCT) {
      out.push(
        warning(
          "data_budget",
          used >= 100 ? "critical" : "warning",
          `Data credits are at ${used}% of the monthly budget (${spent.data_credits} of ${dataBudget}).`,
          used >= 100
            ? `Data spend is blocked until next month. If more spend is intended, ${askToRaiseBudget("data.monthly_credit_budget")}.`
            : `Watch data spend (get_report type costs), or ${askToRaiseBudget("data.monthly_credit_budget")}.`,
          { type: "workspace", id: workspace.id },
        ),
      );
    }
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return { warnings: out, brainConfigured: providerWarnings.brainConfigured };
}

interface ProviderNeeds {
  linkedin: boolean;
  social: boolean;
  leadSources: string[];
  collectors: string[];
}

/** Providers the workspace's enabled features need but that do not resolve. */
async function providerChecks(
  ctx: OpContext,
  workspace: Workspace,
  needs: ProviderNeeds,
): Promise<{ warnings: Warning[]; brainConfigured: boolean }> {
  const settings = settingsOf(workspace);
  const checks: Array<{ slot: Slot; id?: string; feature: string; severity: Severity }> = [
    { slot: "brain", feature: "writing, research and reply classification", severity: "critical" },
  ];
  if (needs.linkedin) {
    checks.push({ slot: "linkedin", feature: "LinkedIn accounts and steps", severity: "warning" });
  }
  if (needs.social) {
    checks.push({ slot: "social", feature: "approved or scheduled posts", severity: "warning" });
  }
  for (const id of settings.data.enrichment.finders) {
    checks.push({
      slot: "email_finder",
      id,
      feature: "the enrichment waterfall",
      severity: "warning",
    });
  }
  if (settings.data.enrichment.verifier) {
    checks.push({
      slot: "email_verifier",
      id: settings.data.enrichment.verifier,
      feature: "email verification",
      severity: "warning",
    });
  }
  for (const id of needs.leadSources) {
    checks.push({
      slot: "lead_source",
      id,
      feature: "enabled saved searches",
      severity: "warning",
    });
  }
  for (const id of needs.collectors) {
    checks.push({ slot: "signals", id, feature: "enabled signal monitors", severity: "warning" });
  }

  const results = await Promise.all(
    checks.map(async (check) => {
      try {
        const instance = await ctx.providers.tryGet(
          check.slot,
          check.id === undefined ? undefined : { id: check.id },
        );
        return { check, ok: instance !== null, error: null as string | null };
      } catch (error) {
        const message = isOpenOutboundError(error) ? error.message : "it failed to load";
        return { check, ok: false, error: message };
      }
    }),
  );
  const warnings: Warning[] = [];
  for (const { check, ok, error } of results) {
    if (ok) continue;
    const name = check.id ? `${check.slot} provider "${check.id}"` : `${check.slot} provider`;
    warnings.push(
      warning(
        error ? "provider_error" : "provider_missing",
        check.severity,
        error
          ? `The ${name} used by ${check.feature} is misconfigured: ${error}`
          : `No ${name} is configured, but ${check.feature} need one.`,
        check.slot === "brain"
          ? "Configure one with manage_providers (action set, slot brain), or set ANTHROPIC_API_KEY or OPENAI_API_KEY."
          : `Configure it with manage_providers (action set, slot ${check.slot}${check.id ? `, provider ${check.id}` : ""}), or turn the feature off.`,
        { type: "provider", id: check.id ? `${check.slot}:${check.id}` : check.slot },
      ),
    );
  }
  const brain = results.find((result) => result.check.slot === "brain");
  return { warnings, brainConfigured: Boolean(brain?.ok) };
}
