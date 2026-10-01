import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/client.js";
import {
  type LinkedInAccount,
  linkedin_accounts,
  type Mailbox,
  mailboxes,
} from "../../../db/schema/index.js";
import { mailboxRampOutlook } from "../../email/service.js";
import { resolveLimits } from "../../linkedin/limits.js";
import { activityCounts, EMPTY_ACTIVITY } from "../activity.js";
import { rate } from "../metric.js";
import type { LinkedInRow, MailboxRow, SendersData } from "../schemas.js";
import {
  attributedDef,
  inWorkspaces,
  repliesDef,
  rows,
  sentDef,
  type Window,
  windowsDef,
  withDefs,
} from "../sql.js";
import { DAY_MS, isValidTimeZone, startOfLocalDay } from "../timezone.js";
import { type BuildArgs, type Built, compareCount, compareRate, windowsOf } from "./common.js";

/**
 * Today's daily email limit including the ramp (quiet setup weeks, then start + increment),
 * computed by the email module so the report matches what the sender actually allows.
 */
export function effectiveDailyLimit(
  mailbox: Pick<Mailbox, "daily_limit" | "ramp" | "created_at">,
  now: Date,
  timeZone: string,
): number {
  return mailboxRampOutlook(mailbox, now, timeZone).today_limit;
}

interface SenderSentRow {
  mailbox_id: string | null;
  linkedin_account_id: string | null;
  channel: string;
  action: string;
  status: string;
  n: number;
  people: number;
}

/** Per mailbox and LinkedIn account: volume, bounces, replies, status and limits used today. */
export async function buildSenders(args: BuildArgs): Promise<Built<SendersData>> {
  const workspaceId = args.workspace.id;
  const ids = [workspaceId];
  const windows = windowsOf(args);
  const current: Window = windows[0] ?? { from: args.current.from, to: args.current.to };
  const [mailboxList, accountList, totals, sent, replies, accepted] = await Promise.all([
    args.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.workspace_id, workspaceId))
      .orderBy(asc(mailboxes.email)),
    args.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.workspace_id, workspaceId))
      .orderBy(asc(linkedin_accounts.created_at)),
    activityCounts(args.db, ids, windows),
    rows<SenderSentRow>(
      args.db,
      sql`${withDefs(windowsDef([current]), sentDef(ids))}
        select mailbox_id, linkedin_account_id, channel, action, status,
          count(*)::int as n, count(distinct person_id)::int as people
        from sent
        group by 1, 2, 3, 4, 5`,
    ),
    rows<{ mailbox_id: string | null; linkedin_account_id: string | null; n: number }>(
      args.db,
      sql`${withDefs(windowsDef([current]), repliesDef(ids), attributedDef())}
        select mailbox_id, linkedin_account_id, count(distinct person_id)::int as n
        from attributed
        group by 1, 2`,
    ),
    rows<{ linkedin_account_id: string; n: number }>(
      args.db,
      sql`${withDefs(windowsDef([current]), sentDef(ids))}
        select s.linkedin_account_id, count(distinct s.person_id)::int as n
        from sent s
        join linkedin_relations lr
          on lr.account_id = s.linkedin_account_id and lr.person_id = s.person_id
        where s.action = 'invite' and lr.status = 'connected'
        group by 1`,
    ),
  ]);
  const usage = await usageToday(args.db, args, mailboxList, accountList);

  const mailboxRows: MailboxRow[] = mailboxList.map((mailbox) => {
    const own = sent.filter((row) => row.mailbox_id === mailbox.id && row.channel === "email");
    const sentCount = own.reduce((total, row) => total + row.n, 0);
    const bounced = own
      .filter((row) => row.status === "bounced")
      .reduce((total, row) => total + row.n, 0);
    const limit = effectiveDailyLimit(mailbox, args.now, args.workspace.timezone);
    const today = usage.mailboxToday.get(mailbox.id) ?? 0;
    return {
      id: mailbox.id,
      email: mailbox.email,
      status: mailbox.status,
      status_reason: mailbox.status_reason,
      sent: sentCount,
      bounced,
      bounce_rate: rate(bounced, sentCount),
      replies: replies
        .filter((row) => row.mailbox_id === mailbox.id)
        .reduce((total, row) => total + row.n, 0),
      daily_limit: limit,
      sent_today: today,
      limit_used_pct: rate(today, limit),
      sync_error: mailbox.health?.last_sync_error ?? null,
    };
  });

  const accountRows: LinkedInRow[] = accountList.map((account) => {
    const own = sent.filter(
      (row) => row.linkedin_account_id === account.id && row.channel === "linkedin",
    );
    const count = (actions: string[]) =>
      own.filter((row) => actions.includes(row.action)).reduce((total, row) => total + row.n, 0);
    const invites = count(["invite"]);
    const acceptedCount = accepted.find((row) => row.linkedin_account_id === account.id)?.n ?? 0;
    const limits = resolveLimits(account.limits);
    const today = usage.accountToday.get(account.id) ?? {};
    const used = (actions: string[]) =>
      actions.reduce((total, action) => total + (today[action] ?? 0), 0);
    return {
      id: account.id,
      name: account.name,
      provider: account.provider,
      status: account.status,
      status_reason: account.status_reason,
      invites_sent: invites,
      invites_accepted: acceptedCount,
      acceptance_rate: rate(acceptedCount, invites),
      messages_sent: count(["message", "reply"]),
      other_actions: count(["visit", "like", "comment"]),
      replies: replies
        .filter((row) => row.linkedin_account_id === account.id)
        .reduce((total, row) => total + row.n, 0),
      limits: {
        invites_per_day: { used: used(["invite"]), limit: limits.invites_per_day },
        invites_per_week: {
          used: usage.accountInvitesWeek.get(account.id) ?? 0,
          limit: limits.invites_per_week,
        },
        messages_per_day: { used: used(["message", "reply"]), limit: limits.messages_per_day },
        visits_per_day: { used: used(["visit"]), limit: limits.visits_per_day },
        likes_per_day: { used: used(["like"]), limit: limits.likes_per_day },
        comments_per_day: { used: used(["comment"]), limit: limits.comments_per_day },
      },
    };
  });

  const perWindow = totals.get(workspaceId) ?? [];
  const cur = perWindow[0] ?? EMPTY_ACTIVITY;
  const prev = args.previous ? (perWindow[1] ?? EMPTY_ACTIVITY) : undefined;
  const notes: string[] = [];
  if (mailboxList.length === 0 && accountList.length === 0) {
    notes.push(
      "No senders yet: add a mailbox with manage_mailboxes or connect LinkedIn with manage_linkedin.",
    );
  }
  return {
    data: {
      type: "senders",
      metrics: {
        emails_sent: compareCount(cur, prev, (row) => row.emails_sent),
        bounced: compareCount(cur, prev, (row) => row.bounced),
        bounce_rate: compareRate(
          cur,
          prev,
          (row) => row.bounced,
          (row) => row.emails_sent,
        ),
        linkedin_sent: compareCount(cur, prev, (row) => row.linkedin_sent),
        replies: compareCount(cur, prev, (row) => row.replies),
      },
      mailboxes: mailboxRows,
      linkedin_accounts: accountRows,
    },
    metrics: ["emails_sent", "bounced", "bounce_rate", "linkedin_sent", "replies"],
    notes: [
      ...notes,
      "sent_today and LinkedIn limits count actions since local midnight (workspace timezone for mailboxes, account timezone for LinkedIn); daily_limit includes the ramp.",
    ],
  };
}

interface Usage {
  mailboxToday: Map<string, number>;
  accountToday: Map<string, Record<string, number>>;
  accountInvitesWeek: Map<string, number>;
}

/**
 * Actions sent today per sender, one query for every timezone involved: windows are
 * [local midnight, now) per distinct timezone plus a rolling 7-day window for weekly invites.
 */
async function usageToday(
  db: Db,
  args: Pick<BuildArgs, "workspace" | "now">,
  mailboxList: Mailbox[],
  accountList: LinkedInAccount[],
): Promise<Usage> {
  const usage: Usage = {
    mailboxToday: new Map(),
    accountToday: new Map(),
    accountInvitesWeek: new Map(),
  };
  if (mailboxList.length === 0 && accountList.length === 0) return usage;
  const workspaceZone = zoneOr(args.workspace.timezone, "UTC");
  const zones = [
    ...new Set([workspaceZone, ...accountList.map((a) => zoneOr(a.timezone, workspaceZone))]),
  ];
  const windows: Window[] = zones.map((zone) => ({
    from: startOfLocalDay(args.now, zone),
    to: args.now,
  }));
  const weekIndex = windows.length;
  windows.push({ from: new Date(args.now.getTime() - 7 * DAY_MS), to: args.now });
  const list = await rows<{
    idx: number;
    mailbox_id: string | null;
    linkedin_account_id: string | null;
    channel: string;
    action: string;
    n: number;
  }>(
    db,
    sql`${withDefs(windowsDef(windows))}
      select w.idx, m.mailbox_id, m.linkedin_account_id, m.channel, m.action, count(*)::int as n
      from messages m join w on m.sent_at >= w.f and m.sent_at < w.t
      where ${inWorkspaces("m", [args.workspace.id])} and m.direction = 'outbound'
        and m.origin = 'engine' and m.status in ('sent', 'bounced')
      group by 1, 2, 3, 4, 5`,
  );
  const mailboxIndex = zones.indexOf(workspaceZone);
  for (const row of list) {
    if (row.channel === "email" && row.mailbox_id && row.idx === mailboxIndex) {
      usage.mailboxToday.set(row.mailbox_id, (usage.mailboxToday.get(row.mailbox_id) ?? 0) + row.n);
    }
  }
  for (const account of accountList) {
    const index = zones.indexOf(zoneOr(account.timezone, workspaceZone));
    const today: Record<string, number> = {};
    let week = 0;
    for (const row of list) {
      if (row.channel !== "linkedin" || row.linkedin_account_id !== account.id) continue;
      if (row.idx === index) today[row.action] = (today[row.action] ?? 0) + row.n;
      if (row.idx === weekIndex && row.action === "invite") week += row.n;
    }
    usage.accountToday.set(account.id, today);
    usage.accountInvitesWeek.set(account.id, week);
  }
  return usage;
}

function zoneOr(zone: string | null | undefined, fallback: string): string {
  return zone && isValidTimeZone(zone) ? zone : fallback;
}
