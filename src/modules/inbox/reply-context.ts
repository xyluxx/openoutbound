/** Loads everything the inbox needs about one inbound message, scoped to the workspace. */
import { and, desc, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { notFound } from "../../core/errors.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../core/settings.js";
import {
  type Campaign,
  type Company,
  campaigns,
  companies,
  type Message,
  messages,
  type Person,
  people,
  type Thread,
  threads,
  type Workspace,
} from "../../db/schema/index.js";

export interface ReplyContext {
  workspace: Workspace;
  settings: WorkspaceSettings;
  /** The inbound message being handled. */
  message: Message;
  thread: Thread | null;
  person: Person | null;
  company: Company | null;
  campaign: Campaign | null;
}

export async function findThread(ctx: OpContext, threadId: string): Promise<Thread | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(threads)
    .where(and(eq(threads.workspace_id, workspace.id), eq(threads.id, threadId)))
    .limit(1);
  return row ?? null;
}

export async function requireThread(ctx: OpContext, threadId: string): Promise<Thread> {
  const thread = await findThread(ctx, threadId);
  if (!thread) throw notFound("Thread", threadId);
  return thread;
}

export async function findMessage(ctx: OpContext, messageId: string): Promise<Message | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.workspace_id, workspace.id), eq(messages.id, messageId)))
    .limit(1);
  return row ?? null;
}

/** Latest inbound message of a thread (what a reply answers). */
export async function latestInbound(ctx: OpContext, threadId: string): Promise<Message | null> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.thread_id, threadId),
        eq(messages.direction, "inbound"),
      ),
    )
    .orderBy(desc(messages.created_at), desc(messages.id))
    .limit(1);
  return row ?? null;
}

/** Thread messages, oldest first (the newest `limit`). */
export async function threadMessages(
  ctx: OpContext,
  threadId: string,
  limit: number,
): Promise<Message[]> {
  const workspace = requireWorkspace(ctx);
  const rows = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.workspace_id, workspace.id), eq(messages.thread_id, threadId)))
    .orderBy(desc(messages.created_at), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

export async function findPerson(ctx: OpContext, personId: string | null): Promise<Person | null> {
  if (!personId) return null;
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspace.id), eq(people.id, personId)))
    .limit(1);
  return row ?? null;
}

export async function findCompany(
  ctx: OpContext,
  companyId: string | null,
): Promise<Company | null> {
  if (!companyId) return null;
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(companies)
    .where(and(eq(companies.workspace_id, workspace.id), eq(companies.id, companyId)))
    .limit(1);
  return row ?? null;
}

export async function findCampaign(
  ctx: OpContext,
  campaignId: string | null,
): Promise<Campaign | null> {
  if (!campaignId) return null;
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspace_id, workspace.id), eq(campaigns.id, campaignId)))
    .limit(1);
  return row ?? null;
}

/** Null when the message is not in the workspace. */
export async function loadReplyContext(
  ctx: OpContext,
  messageId: string,
): Promise<ReplyContext | null> {
  const workspace = requireWorkspace(ctx);
  const message = await findMessage(ctx, messageId);
  if (!message) return null;
  const thread = message.thread_id ? await findThread(ctx, message.thread_id) : null;
  const person = await findPerson(ctx, message.person_id ?? thread?.person_id ?? null);
  const company = await findCompany(
    ctx,
    message.company_id ?? thread?.company_id ?? person?.company_id ?? null,
  );
  const campaign = await findCampaign(ctx, message.campaign_id ?? thread?.campaign_id ?? null);
  return {
    workspace,
    settings: parseWorkspaceSettings(workspace.settings),
    message,
    thread,
    person,
    company,
    campaign,
  };
}

/** Our latest outbound text in the thread before a message (context for classification). */
export async function lastOutboundBefore(
  ctx: OpContext,
  threadId: string,
  before: Date,
): Promise<Message | null> {
  const rows = await threadMessages(ctx, threadId, 20);
  const candidates = rows.filter(
    (row) => row.direction === "outbound" && row.created_at.getTime() <= before.getTime(),
  );
  return candidates.at(-1) ?? null;
}
