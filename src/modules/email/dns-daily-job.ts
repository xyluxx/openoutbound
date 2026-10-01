/**
 * Daily DNS check (setting `sending.daily_dns_check`): every day at 06:17 UTC, each workspace
 * re-checks MX, SPF, DKIM and DMARC for every domain of its active or warming mailboxes and stores
 * the result like `check_dns`. A record that stops passing (green before, yellow or red now; or
 * red now after yellow, or on a domain never checked) opens one `dns_failed` problem per domain
 * naming the records that changed, emits `mailbox.dns_failed` for each sending mailbox and
 * notifies. The problem is resolved when the records it names are green again. A lookup that
 * failed (DNS error) is no change. Mailboxes are never paused.
 */
import { and, eq, like, ne } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { type BuiltinSchedule, defineJob } from "../../core/operation.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { type Mailbox, type MailboxDnsCheck, mailboxes, problems } from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { listProblems, openProblem, resolveProblemsFor } from "../problems/service.js";
import { type CheckStatus, checkDomainDns, type DnsCheckItem } from "./dns-check.js";
import { toStoredCheck } from "./operations/dns.js";

export const DNS_DAILY_JOB = "email.dns_daily_check";

/** Daily at 06:17 UTC, per workspace. */
export const dnsDailySchedule: BuiltinSchedule = {
  name: DNS_DAILY_JOB,
  cron: "17 6 * * *",
  job: DNS_DAILY_JOB,
  perWorkspace: true,
};

const SENDING_STATUSES: ReadonlySet<Mailbox["status"]> = new Set(["active", "warming"]);

type CheckName = DnsCheckItem["name"];

/** The checks in the order they are listed. */
const CHECK_NAMES: readonly CheckName[] = ["mx", "spf", "dkim", "dmarc"];

export interface DomainDnsResult {
  domain: string;
  overall: "green" | "yellow" | "red";
  /** Records the domain's `dns_failed` problem names that do not pass now. */
  failed: CheckName[];
  /**
   * failed: a record stopped passing (problem opened or updated, event, notification);
   * recovered: the problem's records pass again (resolved); still_failed: the problem stays open
   * or a record is red as before; ok: nothing to act on.
   */
  action: "ok" | "failed" | "still_failed" | "recovered";
  mailboxes_updated: number;
}

export interface DailyDnsResult {
  skipped: "setting_off" | "sandbox" | null;
  domains: DomainDnsResult[];
  /** Problems resolved because their domain has no active or warming mailbox any more. */
  resolved_without_mailboxes: number;
}

/** Dedupe key of the `dns_failed` problem of a domain. */
export function dnsFailedKey(domain: string): string {
  return `dns_failed:${domain}`;
}

function domainOf(mailbox: Pick<Mailbox, "email">): string {
  return mailbox.email
    .slice(mailbox.email.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase();
}

/** The newest stored check among the domain's mailboxes. */
function latestCheck(rows: Mailbox[]): MailboxDnsCheck | null {
  let latest: MailboxDnsCheck | null = null;
  for (const row of rows) {
    if (row.dns && (!latest || row.dns.checked_at > latest.checked_at)) latest = row.dns;
  }
  return latest;
}

/**
 * A check's status in the stored result, or null when the domain was never checked. Older rows
 * keep only whether each check passed: one that did not counts as red when the stored overall
 * result was red, else as yellow.
 */
function previousStatus(previous: MailboxDnsCheck | null, name: CheckName): CheckStatus | null {
  if (!previous) return null;
  const status = previous.statuses?.[name];
  if (status) return status;
  if (previous[name] === true) return "green";
  return previous.overall === "red" ? "red" : "yellow";
}

/**
 * A record stopped passing: it was green and is not now, or it is red now and was not (worse
 * than yellow, or a domain never checked). A failed lookup says nothing about the record.
 */
function stoppedPassing(before: CheckStatus | null, check: DnsCheckItem): boolean {
  if (check.status === "green" || check.lookup_failed) return false;
  if (before === "green") return true;
  return check.status === "red" && before !== "red";
}

/** The records the domain's unresolved `dns_failed` problem names, or null without one. */
async function problemRecords(ctx: OpContext, domain: string): Promise<CheckName[] | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ data: problems.data })
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, workspace.id),
        eq(problems.dedupe_key, dnsFailedKey(domain)),
        ne(problems.status, "resolved"),
      ),
    )
    .limit(1);
  if (!row) return null;
  const named = Array.isArray(row.data.failed) ? row.data.failed : [];
  const records = CHECK_NAMES.filter((name) => named.includes(name));
  // A problem that names no record waits for every record to pass.
  return records.length > 0 ? records : [...CHECK_NAMES];
}

async function safeNotify(ctx: OpContext, input: Parameters<typeof notify>[1]): Promise<void> {
  try {
    await notify(ctx, input);
  } catch (error) {
    ctx.log.warn({ err: String(error) }, "email: DNS notification failed");
  }
}

function recordList(names: CheckName[]): string {
  const upper = names.map((name) => name.toUpperCase());
  return upper.length <= 1
    ? (upper[0] ?? "")
    : `${upper.slice(0, -1).join(", ")} and ${upper[upper.length - 1]}`;
}

/**
 * Opens (or updates) the domain's problem naming every record it is about (`failing`: those that
 * stopped passing, now and on earlier days while it was open), then emits and notifies for the
 * records that changed today.
 */
async function alert(
  ctx: OpContext,
  domain: string,
  failing: DnsCheckItem[],
  changed: DnsCheckItem[],
  sending: Mailbox[],
): Promise<void> {
  const names = failing.map((check) => check.name);
  const records = recordList(names);
  const changedNames = changed.map((check) => check.name);
  const earlier = failing.length > changed.length;
  const [first] = sending;
  const confirm = first
    ? `Then run manage_mailboxes action check_dns with mailbox_id ${first.id} to confirm.`
    : "Then run manage_mailboxes action check_dns to confirm.";
  await openProblem(ctx, {
    kind: "dns_failed",
    severity: "high",
    owner: "person",
    title: `${records} failed for ${domain}`,
    reason: `The daily DNS check found ${records} of ${domain} not passing: ${failing.map((check) => `${check.name.toUpperCase()} is ${check.status}: ${check.summary}`).join(" ")}${earlier ? ` New since the last check: ${recordList(changedNames)}.` : ""} Mail from ${sending.length} mailbox${sending.length === 1 ? "" : "es"} on this domain is more likely to bounce or land in spam. The mailboxes keep sending.`,
    remedy: [
      ...failing.map((check) => `${check.name.toUpperCase()}: ${check.fix ?? "Fix the record."}`),
      confirm,
    ].join(" "),
    subject: { type: "domain", id: domain },
    data: {
      domain,
      failed: names,
      changed: changedNames,
      mailbox_ids: sending.map((mailbox) => mailbox.id),
    },
    dedupeKey: dnsFailedKey(domain),
  });
  for (const mailbox of sending) {
    await ctx.events.emit("mailbox.dns_failed", {
      subject: { type: "mailbox", id: mailbox.id },
      data: { mailbox_id: mailbox.id, domain, failed: changedNames },
    });
  }
  await safeNotify(ctx, {
    title: `DNS check failed for ${domain}: ${recordList(changedNames)}`,
    lines: [
      ...changed.map((check) => `${check.name.toUpperCase()}: ${check.summary}`),
      "The mailboxes keep sending. Fix the records, then run manage_mailboxes action check_dns.",
    ],
    severity: "warning",
    event: "mailbox.dns_failed",
  });
}

/**
 * Checks one domain against its stored result: alerts when a record stops passing, resolves the
 * problem when its records pass again, then stores the result.
 */
export async function checkDomainDaily(
  ctx: OpContext,
  domain: string,
  rows: Mailbox[],
): Promise<DomainDnsResult> {
  const workspace = requireWorkspace(ctx);
  const sending = rows.filter((row) => SENDING_STATUSES.has(row.status));
  const label = sending
    .map((row) => row.provider_label)
    .find((value) => value !== "custom" && value !== "sandbox");
  const result = await checkDomainDns(domain, ctx.dns, {
    ...(label ? { provider: label } : {}),
    now: ctx.clock.now(),
  });
  const previous = latestCheck(rows);
  const passes = (name: CheckName) =>
    result.checks.find((check) => check.name === name)?.status === "green";
  const changed = result.checks.filter((check) =>
    stoppedPassing(previousStatus(previous, check.name), check),
  );
  const named = await problemRecords(ctx, domain);
  const tracked = CHECK_NAMES.filter(
    (name) => named?.includes(name) || changed.some((check) => check.name === name),
  );
  let action: DomainDnsResult["action"];
  if (changed.length > 0) {
    // Alert before storing: when alerting fails, the job retries against the old result.
    const failing = result.checks.filter(
      (check) => tracked.includes(check.name) && check.status !== "green",
    );
    await alert(ctx, domain, failing, changed, sending);
    action = "failed";
  } else if (named && tracked.every(passes)) {
    await resolveProblemsFor(
      ctx,
      { dedupeKey: dnsFailedKey(domain) },
      `The daily DNS check found ${recordList(tracked)} passing again for ${domain}.`,
    );
    action = "recovered";
  } else if (named || result.checks.some((check) => check.status === "red")) {
    action = "still_failed";
  } else {
    action = "ok";
  }
  const stored = toStoredCheck(result);
  // A failed lookup says nothing about the record: keep the status known before, so the next
  // check compares with it.
  for (const check of result.checks) {
    const before = previousStatus(previous, check.name);
    if (check.lookup_failed && before && stored.statuses) stored.statuses[check.name] = before;
  }
  const updated = await ctx.db
    .update(mailboxes)
    .set({ dns: stored })
    .where(and(eq(mailboxes.workspace_id, workspace.id), like(mailboxes.email, `%@${domain}`)))
    .returning({ id: mailboxes.id });
  return {
    domain,
    overall: result.overall,
    failed: tracked.filter((name) => !passes(name)),
    action,
    mailboxes_updated: updated.length,
  };
}

/** Resolves `dns_failed` problems of domains that no longer have a sending mailbox. */
async function resolveGoneDomains(ctx: OpContext, checked: Set<string>): Promise<number> {
  let resolved = 0;
  let cursor: string | undefined;
  do {
    const page = await listProblems(ctx, {
      kinds: ["dns_failed"],
      statuses: ["open", "snoozed"],
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const problem of page.items) {
      const domain = typeof problem.data?.domain === "string" ? problem.data.domain : null;
      if (!domain || checked.has(domain)) continue;
      resolved += await resolveProblemsFor(
        ctx,
        { dedupeKey: dnsFailedKey(domain) },
        `No active or warming mailbox uses ${domain} any more.`,
      );
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return resolved;
}

/** The daily DNS check of the context's workspace. */
export async function runDailyDnsCheck(ctx: OpContext): Promise<DailyDnsResult> {
  const workspace = requireWorkspace(ctx);
  const settings = parseWorkspaceSettings(workspace.settings);
  if (!settings.sending.daily_dns_check) {
    return { skipped: "setting_off", domains: [], resolved_without_mailboxes: 0 };
  }
  if (workspace.is_sandbox) {
    return { skipped: "sandbox", domains: [], resolved_without_mailboxes: 0 };
  }
  const rows = await ctx.db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.workspace_id, workspace.id));
  const byDomain = new Map<string, Mailbox[]>();
  for (const row of rows) {
    const domain = domainOf(row);
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), row]);
  }
  const sendingDomains = [...byDomain.entries()]
    .filter(([, list]) =>
      list.some((row) => SENDING_STATUSES.has(row.status) && row.provider_label !== "sandbox"),
    )
    .map(([domain]) => domain)
    .sort();
  const domains: DomainDnsResult[] = [];
  const errors: unknown[] = [];
  for (const domain of sendingDomains) {
    try {
      domains.push(await checkDomainDaily(ctx, domain, byDomain.get(domain) ?? []));
    } catch (error) {
      ctx.log.warn({ domain, err: String(error) }, "email: daily DNS check failed for a domain");
      errors.push(error);
    }
  }
  const resolved = await resolveGoneDomains(ctx, new Set(sendingDomains));
  // A domain whose alert failed kept its old result: the job's retry checks it again, and the
  // domains already stored do not alert twice.
  if (errors.length > 0) throw errors[0];
  return { skipped: null, domains, resolved_without_mailboxes: resolved };
}

export const dnsDailyJob = defineJob({
  name: DNS_DAILY_JOB,
  maxAttempts: 2,
  handler: (ctx) => runDailyDnsCheck(ctx),
});
