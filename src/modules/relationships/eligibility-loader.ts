/**
 * Read-only data access for the send gate: every read is memoized, and a batch of views can be
 * prefetched with a handful of queries (people, companies, contactability, messages, privacy
 * requests and approvals for all of them at once). The senders use single reads only (people,
 * companies and contactability one at a time, exactly as they always read them).
 */
import { and, asc, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { type BudgetStatus, type OpContext, requireWorkspace } from "../../core/context.js";
import type { Channel, MessageStatus } from "../../core/enums.js";
import {
  type CampaignSettings,
  parseCampaignSettings,
  parseStepConfig,
  parseWorkspaceSettings,
  type WorkspaceSettings,
} from "../../core/settings.js";
import {
  approvals,
  type Campaign,
  type CampaignStep,
  type Company,
  campaign_steps,
  campaigns,
  companies,
  type Enrollment,
  enrollments,
  type LinkedInAccount,
  type LinkedInRelation,
  linkedin_accounts,
  type Mailbox,
  type Message,
  mailboxes,
  messages,
  type Person,
  people,
  problems,
  sender_counters,
  suppressions,
  type Thread,
  threads,
  type Workspace,
  workspaces,
} from "../../db/schema/index.js";
import { PENDING_MESSAGE_STATUSES } from "../campaigns/control.js";
import { singleRecipient } from "../email/compose.js";
import {
  type ContactableResult,
  checkContactable,
  checkContactableMany,
  loadCompanies,
  loadPeople,
} from "../leads/service.js";
import { findRelation } from "../linkedin/relations.js";

/** Outbound statuses of a message that has not gone out yet (in flight included). */
export const OPEN_MESSAGE_STATUSES: readonly MessageStatus[] = [
  ...PENDING_MESSAGE_STATUSES,
  "sending",
  "unknown",
];

/** Suppression codes in a fixed order: the address first, then its domain. */
function suppressionCodes(types: readonly string[]): string[] {
  return ["email", "domain"]
    .filter((type) => types.includes(type))
    .map((type) => `suppressed_${type}`);
}

/** What the loader needs to know about one check to prefetch it. */
export interface PrefetchItem {
  personId: string;
  channel: Channel;
  messageId?: string | null;
  campaignId?: string | null;
}

export interface PendingApproval {
  id: string;
  created_at: Date;
  expires_at: Date | null;
}

export interface PrivacyProblem {
  id: string;
  created_at: Date;
}

export class EligibilityLoader {
  private readonly cache = new Map<string, Promise<unknown>>();

  private constructor(
    /** The caller's context with the workspace row read fresh (status and settings). */
    readonly ctx: OpContext,
    readonly workspace: Workspace,
    readonly settings: WorkspaceSettings,
    readonly now: Date,
  ) {}

  /** A loader for the context workspace (its row is read again: it may have changed). */
  static async create(ctx: OpContext): Promise<EligibilityLoader> {
    const current = requireWorkspace(ctx);
    const [row] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, current.id));
    return EligibilityLoader.forWorkspace(ctx, row ?? current);
  }

  /** A loader for a workspace row the caller just read (a send job reads it fresh itself). */
  static forWorkspace(ctx: OpContext, workspace: Workspace): EligibilityLoader {
    return new EligibilityLoader(
      { ...ctx, workspace },
      workspace,
      parseWorkspaceSettings(workspace.settings),
      ctx.clock.now(),
    );
  }

  /** A message row the caller already read (the send job's own), so it is not read again. */
  remember(message: Message): void {
    this.seed(`message:${message.id}`, message);
  }

  /**
   * Context for the planners as if the workspace were active: a paused workspace is its own
   * blocker, and the windows and caps still say when a send could happen after the resume.
   */
  get planCtx(): OpContext {
    return { ...this.ctx, workspace: { ...this.workspace, status: "active" } };
  }

  /**
   * One read per key. `Promise.resolve` matters: a query builder is a lazy thenable that runs
   * its query again on every await, so the builder itself must never be cached.
   */
  private memo<T>(key: string, load: () => PromiseLike<T>): Promise<T> {
    let found = this.cache.get(key) as Promise<T> | undefined;
    if (!found) {
      found = Promise.resolve(load());
      this.cache.set(key, found);
    }
    return found;
  }

  private seed<T>(key: string, value: T): void {
    this.cache.set(key, Promise.resolve(value));
  }

  /** Loads what a batch of checks reads most, in a few queries. */
  async prefetch(items: readonly PrefetchItem[]): Promise<void> {
    const ws = this.workspace.id;
    const personIds = [...new Set(items.map((item) => item.personId))];
    if (personIds.length === 0) return;
    const people = await loadPeople(this.ctx, personIds);
    const found = new Map(people.map((person) => [person.id, person]));
    for (const id of personIds) this.seed(`person:${id}`, found.get(id) ?? null);
    const companyIds = [...new Set(people.map((p) => p.company_id).filter((c) => c !== null))];
    const companyRows = companyIds.length > 0 ? await loadCompanies(this.ctx, companyIds) : [];
    const companies = new Map(companyRows.map((company) => [company.id, company]));
    for (const cid of companyIds) this.seed(`company:${cid}`, companies.get(cid) ?? null);

    for (const channel of ["email", "linkedin"] as const) {
      const ids = [
        ...new Set(items.filter((i) => i.channel === channel).map((i) => i.personId)),
      ].filter((pid) => found.has(pid));
      if (ids.length === 0) continue;
      const results = await checkContactableMany(this.ctx, ids, channel);
      for (const [pid, result] of results) this.seed(`contactable:${channel}:${pid}`, result);
    }

    const messageIds = [...new Set(items.map((i) => i.messageId).filter((m) => m))] as string[];
    const messageRows =
      messageIds.length > 0
        ? await this.ctx.db
            .select()
            .from(messages)
            .where(and(eq(messages.workspace_id, ws), inArray(messages.id, messageIds)))
        : [];
    const byId = new Map(messageRows.map((row) => [row.id, row]));
    for (const mid of messageIds) this.seed(`message:${mid}`, byId.get(mid) ?? null);
    await this.prefetchEnrollments(items, messageRows);
    await this.prefetchThreads(messageRows);
    await this.prefetchSuppressions(items, found, byId);

    const withoutMessage = [...new Set(items.filter((i) => !i.messageId).map((i) => i.personId))];
    const pending =
      withoutMessage.length > 0 ? await this.openMessagesQuery(withoutMessage) : new Map();
    for (const pid of withoutMessage) this.seed(`open:${pid}`, pending.get(pid) ?? []);

    const privacy = await this.ctx.db
      .select({ id: problems.id, person_id: problems.person_id, created_at: problems.created_at })
      .from(problems)
      .where(
        and(
          eq(problems.workspace_id, ws),
          eq(problems.kind, "privacy_request"),
          ne(problems.status, "resolved"),
          inArray(problems.person_id, personIds),
        ),
      )
      .orderBy(asc(problems.created_at));
    for (const pid of personIds) {
      const row = privacy.find((item) => item.person_id === pid);
      this.seed(`privacy:${pid}`, row ? { id: row.id, created_at: row.created_at } : null);
    }

    const openIds = [
      ...messageRows.map((row) => row.id),
      ...[...pending.values()].flat().map((row: Message) => row.id),
    ];
    const approvalRows = openIds.length > 0 ? await this.approvalsQuery(openIds) : [];
    for (const mid of openIds) {
      const row = approvalRows.find((item) => item.target_id === mid);
      this.seed(
        `approval:${mid}`,
        row ? { id: row.id, created_at: row.created_at, expires_at: row.expires_at } : null,
      );
    }
  }

  /** The enrollments of the batch: the messages' own, and the person's in the asked campaign. */
  private async prefetchEnrollments(
    items: readonly PrefetchItem[],
    messageRows: readonly Message[],
  ): Promise<void> {
    const ws = this.workspace.id;
    const ids = [
      ...new Set(messageRows.map((row) => row.enrollment_id).filter((id) => id !== null)),
    ];
    if (ids.length > 0) {
      const rows = await this.ctx.db
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.workspace_id, ws), inArray(enrollments.id, ids)));
      const found = new Map(rows.map((row) => [row.id, row]));
      for (const id of ids) this.seed(`enrollment:${id}`, found.get(id) ?? null);
    }
    const pairs = items.filter((item) => !item.messageId && item.campaignId);
    if (pairs.length === 0) return;
    const campaignIds = [...new Set(pairs.map((item) => item.campaignId as string))];
    const personIds = [...new Set(pairs.map((item) => item.personId))];
    const rows = await this.ctx.db
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.workspace_id, ws),
          inArray(enrollments.campaign_id, campaignIds),
          inArray(enrollments.person_id, personIds),
        ),
      );
    const byPair = new Map(rows.map((row) => [`${row.campaign_id}:${row.person_id}`, row]));
    for (const item of pairs) {
      const key = `${item.campaignId}:${item.personId}`;
      this.seed(`enrollment_in:${key}`, byPair.get(key) ?? null);
    }
  }

  /** The threads of the batch's messages. */
  private async prefetchThreads(messageRows: readonly Message[]): Promise<void> {
    const ids = [...new Set(messageRows.map((row) => row.thread_id).filter((id) => id !== null))];
    if (ids.length === 0) return;
    const rows = await this.ctx.db
      .select()
      .from(threads)
      .where(and(eq(threads.workspace_id, this.workspace.id), inArray(threads.id, ids)));
    const found = new Map(rows.map((row) => [row.id, row]));
    for (const id of ids) this.seed(`thread:${id}`, found.get(id) ?? null);
  }

  /** Address and domain suppressions of every email recipient of the batch, in one query. */
  private async prefetchSuppressions(
    items: readonly PrefetchItem[],
    people: ReadonlyMap<string, Person>,
    messagesById: ReadonlyMap<string, Message>,
  ): Promise<void> {
    const recipients = new Set<string>();
    for (const item of items) {
      if (item.channel !== "email") continue;
      const message = item.messageId ? messagesById.get(item.messageId) : undefined;
      const personId = message ? message.person_id : item.personId;
      const fallback = personId ? (people.get(personId)?.email ?? null) : null;
      const address = singleRecipient(message?.to_address ?? fallback);
      if (address) recipients.add(address);
    }
    if (recipients.size === 0) return;
    const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
    const domains = [...new Set([...recipients].map(domainOf))];
    const rows = await this.ctx.db
      .select({ type: suppressions.type, value: suppressions.value })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.workspace_id, this.workspace.id),
          or(
            and(eq(suppressions.type, "email"), inArray(suppressions.value, [...recipients])),
            and(eq(suppressions.type, "domain"), inArray(suppressions.value, domains)),
          ),
        ),
      );
    for (const recipient of recipients) {
      const domain = domainOf(recipient);
      const types = rows
        .filter(
          (row) =>
            (row.type === "email" && row.value === recipient) ||
            (row.type === "domain" && row.value === domain),
        )
        .map((row) => row.type);
      this.seed(`recipient_suppressions:${recipient}`, suppressionCodes(types));
    }
  }

  /** The workspace's AI or data budget, read once per batch. */
  budget(kind: "ai" | "data"): Promise<BudgetStatus> {
    return this.memo(`budget:${kind}`, () => this.ctx.usage.budgetStatus(this.workspace.id, kind));
  }

  person(personId: string): Promise<Person | null> {
    return this.memo(`person:${personId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(people)
        .where(and(eq(people.workspace_id, this.workspace.id), eq(people.id, personId)))
        .limit(1);
      return row ?? null;
    });
  }

  company(companyId: string | null | undefined): Promise<Company | null> {
    if (!companyId) return Promise.resolve(null);
    return this.memo(`company:${companyId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(companies)
        .where(and(eq(companies.workspace_id, this.workspace.id), eq(companies.id, companyId)))
        .limit(1);
      return row ?? null;
    });
  }

  /** The leads contactability check (`checkContactable`, as the senders call it). */
  contactable(personId: string, channel: Channel): Promise<ContactableResult> {
    return this.memo(`contactable:${channel}:${personId}`, () =>
      checkContactable(this.ctx, { personId, channel }),
    );
  }

  message(messageId: string): Promise<Message | null> {
    return this.memo(`message:${messageId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(messages)
        .where(and(eq(messages.workspace_id, this.workspace.id), eq(messages.id, messageId)))
        .limit(1);
      return row ?? null;
    });
  }

  /** The person's outbound messages that have not gone out yet, soonest first. */
  openMessages(personId: string): Promise<Message[]> {
    return this.memo(`open:${personId}`, async () => {
      const found = await this.openMessagesQuery([personId]);
      return found.get(personId) ?? [];
    });
  }

  private async openMessagesQuery(personIds: string[]): Promise<Map<string, Message[]>> {
    const rows = await this.ctx.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, this.workspace.id),
          inArray(messages.person_id, personIds),
          eq(messages.direction, "outbound"),
          inArray(messages.status, [...OPEN_MESSAGE_STATUSES]),
        ),
      )
      .orderBy(asc(messages.scheduled_for), asc(messages.created_at), asc(messages.id));
    const out = new Map<string, Message[]>();
    for (const row of rows) {
      if (!row.person_id) continue;
      const list = out.get(row.person_id) ?? [];
      list.push(row);
      out.set(row.person_id, list);
    }
    return out;
  }

  private approvalsQuery(messageIds: string[]) {
    return this.ctx.db
      .select({
        id: approvals.id,
        target_id: approvals.target_id,
        created_at: approvals.created_at,
        expires_at: approvals.expires_at,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspace_id, this.workspace.id),
          eq(approvals.status, "pending"),
          eq(approvals.target_type, "message"),
          inArray(approvals.target_id, messageIds),
        ),
      )
      .orderBy(asc(approvals.created_at));
  }

  /** The pending approval that holds this message, if any. */
  pendingApproval(messageId: string): Promise<PendingApproval | null> {
    return this.memo(`approval:${messageId}`, async () => {
      const [row] = await this.approvalsQuery([messageId]);
      return row ? { id: row.id, created_at: row.created_at, expires_at: row.expires_at } : null;
    });
  }

  /** The oldest unresolved privacy request of the person (a snoozed one still counts). */
  privacyRequest(personId: string): Promise<PrivacyProblem | null> {
    return this.memo(`privacy:${personId}`, async () => {
      const [row] = await this.ctx.db
        .select({ id: problems.id, created_at: problems.created_at })
        .from(problems)
        .where(
          and(
            eq(problems.workspace_id, this.workspace.id),
            eq(problems.kind, "privacy_request"),
            ne(problems.status, "resolved"),
            eq(problems.person_id, personId),
          ),
        )
        .orderBy(asc(problems.created_at))
        .limit(1);
      return row ?? null;
    });
  }

  campaign(
    campaignId: string | null | undefined,
  ): Promise<{ campaign: Campaign; settings: CampaignSettings } | null> {
    if (!campaignId) return Promise.resolve(null);
    return this.memo(`campaign:${campaignId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.workspace_id, this.workspace.id), eq(campaigns.id, campaignId)))
        .limit(1);
      return row ? { campaign: row, settings: parseCampaignSettings(row.settings) } : null;
    });
  }

  step(stepId: string | null | undefined): Promise<CampaignStep | null> {
    if (!stepId) return Promise.resolve(null);
    return this.memo(`step:${stepId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(campaign_steps)
        .where(
          and(eq(campaign_steps.workspace_id, this.workspace.id), eq(campaign_steps.id, stepId)),
        )
        .limit(1);
      return row ?? null;
    });
  }

  /** The campaign step at a position (the enrollment's next step). */
  stepAt(campaignId: string, position: number): Promise<CampaignStep | null> {
    return this.memo(`step_at:${campaignId}:${position}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(campaign_steps)
        .where(
          and(
            eq(campaign_steps.workspace_id, this.workspace.id),
            eq(campaign_steps.campaign_id, campaignId),
            eq(campaign_steps.position, position),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  /** `reply` for email steps that continue the thread (the send job's step mode). */
  async stepMode(stepId: string | null | undefined): Promise<"new_thread" | "reply" | null> {
    const step = await this.step(stepId);
    if (step?.type !== "email") return null;
    try {
      return parseStepConfig("email", step.config).mode;
    } catch {
      return null;
    }
  }

  enrollmentById(enrollmentId: string | null | undefined): Promise<Enrollment | null> {
    if (!enrollmentId) return Promise.resolve(null);
    return this.memo(`enrollment:${enrollmentId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(enrollments)
        .where(
          and(eq(enrollments.workspace_id, this.workspace.id), eq(enrollments.id, enrollmentId)),
        )
        .limit(1);
      return row ?? null;
    });
  }

  enrollmentIn(campaignId: string, personId: string): Promise<Enrollment | null> {
    return this.memo(`enrollment_in:${campaignId}:${personId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.workspace_id, this.workspace.id),
            eq(enrollments.campaign_id, campaignId),
            eq(enrollments.person_id, personId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  /** Every enrollment of the person, newest first. */
  personEnrollments(personId: string): Promise<Enrollment[]> {
    return this.memo(`enrollments_of:${personId}`, () =>
      this.ctx.db
        .select()
        .from(enrollments)
        .where(
          and(eq(enrollments.workspace_id, this.workspace.id), eq(enrollments.person_id, personId)),
        )
        .orderBy(desc(enrollments.enrolled_at)),
    );
  }

  thread(threadId: string | null | undefined): Promise<Thread | null> {
    if (!threadId) return Promise.resolve(null);
    return this.memo(`thread:${threadId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(threads)
        .where(and(eq(threads.workspace_id, this.workspace.id), eq(threads.id, threadId)))
        .limit(1);
      return row ?? null;
    });
  }

  /** The thread an enrollment's earlier emails went out in (reply-mode steps continue it). */
  enrollmentThread(enrollmentId: string): Promise<Thread | null> {
    return this.memo(`enrollment_thread:${enrollmentId}`, async () => {
      const [row] = await this.ctx.db
        .select({ thread_id: messages.thread_id })
        .from(messages)
        .where(
          and(
            eq(messages.workspace_id, this.workspace.id),
            eq(messages.enrollment_id, enrollmentId),
            eq(messages.direction, "outbound"),
            eq(messages.status, "sent"),
            isNotNull(messages.thread_id),
          ),
        )
        .orderBy(desc(messages.sent_at))
        .limit(1);
      return this.thread(row?.thread_id ?? null);
    });
  }

  /** The LinkedIn conversation between an account and a person (the action job's lookup). */
  linkedinThread(accountId: string, personId: string): Promise<Thread | null> {
    return this.memo(`linkedin_thread:${accountId}:${personId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(threads)
        .where(
          and(
            eq(threads.workspace_id, this.workspace.id),
            eq(threads.channel, "linkedin"),
            eq(threads.linkedin_account_id, accountId),
            eq(threads.person_id, personId),
          ),
        )
        .orderBy(asc(threads.created_at))
        .limit(1);
      return row ?? null;
    });
  }

  mailbox(mailboxId: string | null | undefined): Promise<Mailbox | null> {
    if (!mailboxId) return Promise.resolve(null);
    return this.memo(`mailbox:${mailboxId}`, async () => {
      const rows = await this.mailboxes([mailboxId]);
      return rows[0] ?? null;
    });
  }

  async mailboxes(ids: readonly string[]): Promise<Mailbox[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return [];
    return this.memo(`mailboxes:${unique.join(",")}`, () =>
      this.ctx.db
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.workspace_id, this.workspace.id), inArray(mailboxes.id, unique))),
    );
  }

  /** Every mailbox of the workspace, oldest first. */
  allMailboxes(): Promise<Mailbox[]> {
    return this.memo("mailboxes:all", () =>
      this.ctx.db
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.workspace_id, this.workspace.id))
        .orderBy(asc(mailboxes.created_at), asc(mailboxes.id)),
    );
  }

  account(accountId: string | null | undefined): Promise<LinkedInAccount | null> {
    if (!accountId) return Promise.resolve(null);
    return this.memo(`account:${accountId}`, async () => {
      const [row] = await this.ctx.db
        .select()
        .from(linkedin_accounts)
        .where(
          and(
            eq(linkedin_accounts.workspace_id, this.workspace.id),
            eq(linkedin_accounts.id, accountId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  /** Every LinkedIn account of the workspace, oldest first. */
  allAccounts(): Promise<LinkedInAccount[]> {
    return this.memo("accounts:all", () =>
      this.ctx.db
        .select()
        .from(linkedin_accounts)
        .where(eq(linkedin_accounts.workspace_id, this.workspace.id))
        .orderBy(asc(linkedin_accounts.created_at), asc(linkedin_accounts.id)),
    );
  }

  relation(accountId: string, personId: string): Promise<LinkedInRelation | null> {
    return this.memo(`relation:${accountId}:${personId}`, () =>
      findRelation(this.ctx.db, accountId, personId),
    );
  }

  /** Emails the mailbox sent on a local day (the send job's daily counter). */
  sentOnDay(mailboxId: string, day: string): Promise<number> {
    return this.memo(`counter:${mailboxId}:${day}`, async () => {
      const [row] = await this.ctx.db
        .select({ count: sender_counters.count })
        .from(sender_counters)
        .where(
          and(
            eq(sender_counters.sender_type, "mailbox"),
            eq(sender_counters.sender_id, mailboxId),
            eq(sender_counters.day, day),
            eq(sender_counters.action, "email"),
          ),
        );
      return row?.count ?? 0;
    });
  }

  /** Suppressions of the exact recipient address and its domain (the send job's lookup). */
  recipientSuppressions(recipient: string): Promise<string[]> {
    return this.memo(`recipient_suppressions:${recipient}`, async () => {
      const domain = recipient.slice(recipient.lastIndexOf("@") + 1);
      const rows = await this.ctx.db
        .select({ type: suppressions.type })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.workspace_id, this.workspace.id),
            or(
              and(eq(suppressions.type, "email"), eq(suppressions.value, recipient)),
              and(eq(suppressions.type, "domain"), eq(suppressions.value, domain)),
            ),
          ),
        );
      return suppressionCodes(rows.map((row) => row.type));
    });
  }
}
