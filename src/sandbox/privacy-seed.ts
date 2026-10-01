/**
 * One seeded privacy request per sandbox workspace, so the demo shows what the engine does when
 * a prospect asks to delete their data: the reply classified `privacy_request` (kind delete),
 * the person suppressed everywhere, and an urgent problem with the deadline, where their data
 * came from and a suggested reply. It uses the person the seed already marks do-not-contact,
 * so nobody contactable changes. Inserts are direct, like the rest of the seed; nothing is
 * emitted or notified. Idempotent: skipped when the workspace has a privacy problem already.
 */
import { and, asc, eq } from "drizzle-orm";
import type { OpContext } from "../core/context.js";
import { parseWorkspaceSettings } from "../core/settings.js";
import {
  companies,
  messages,
  people,
  problems,
  suppressions,
  threads,
  workspaces,
} from "../db/schema/index.js";
import { buildPrivacyProblem } from "../modules/inbox/privacy-requests.js";
import { describeDataSource } from "../modules/inbox/privacy-source.js";

const DAY_MS = 86_400_000;
/** The seeded prospect's reply (fictional). */
export const SEEDED_PRIVACY_REPLY =
  "Please delete my data from your database. I never asked to be contacted and I do not want to hear from you again.";

export interface SeedPrivacyInput {
  workspaceId: string;
  /** The workspace's first mailbox, which "sent" the first email. */
  mailbox: { id: string; email: string } | null;
}

/** The person the sandbox seed marked do-not-contact, when there is one with an email. */
async function doNotContactPerson(ctx: OpContext, workspaceId: string) {
  const [marked] = await ctx.db
    .select({ id: suppressions.value })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.workspace_id, workspaceId),
        eq(suppressions.type, "person"),
        eq(suppressions.reason, "do_not_contact"),
        eq(suppressions.source, "sandbox_seed"),
      ),
    )
    .orderBy(asc(suppressions.created_at))
    .limit(1);
  if (!marked) return null;
  const [person] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspaceId), eq(people.id, marked.id)));
  return person?.email ? person : null;
}

/** Seeds the privacy request; returns false when it was already there or nobody fits. */
export async function seedPrivacyRequest(
  ctx: OpContext,
  input: SeedPrivacyInput,
): Promise<boolean> {
  const { workspaceId, mailbox } = input;
  const [existing] = await ctx.db
    .select({ id: problems.id })
    .from(problems)
    .where(and(eq(problems.workspace_id, workspaceId), eq(problems.kind, "privacy_request")))
    .limit(1);
  if (existing) return false;
  const person = await doNotContactPerson(ctx, workspaceId);
  const [workspace] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!person || !workspace) return false;
  const [company] = person.company_id
    ? await ctx.db
        .select({ name: companies.name })
        .from(companies)
        .where(and(eq(companies.workspace_id, workspaceId), eq(companies.id, person.company_id)))
    : [];

  const now = ctx.clock.now();
  const sentAt = new Date(now.getTime() - 5 * DAY_MS);
  const receivedAt = new Date(now.getTime() - 3 * DAY_MS);
  const first = person.first_name?.trim() || null;
  const subject = first ? `Quick question for ${first}` : "Quick question";
  const [thread] = await ctx.db
    .insert(threads)
    .values({
      workspace_id: workspaceId,
      person_id: person.id,
      company_id: person.company_id,
      channel: "email",
      subject,
      mailbox_id: mailbox?.id ?? null,
      status: "open",
      needs_attention: true,
      category: "privacy_request",
      sentiment: "negative",
      last_message_at: receivedAt,
      last_inbound_at: receivedAt,
    })
    .returning();
  if (!thread) return false;
  await ctx.db.insert(messages).values({
    workspace_id: workspaceId,
    thread_id: thread.id,
    person_id: person.id,
    company_id: person.company_id,
    channel: "email",
    action: "email",
    direction: "outbound",
    status: "sent",
    subject,
    body_text: `Hi ${first ?? "there"}, wanted to ask how you handle ordering today. Worth a quick look?`,
    from_address: mailbox?.email ?? null,
    to_address: person.email,
    mailbox_id: mailbox?.id ?? null,
    sent_at: sentAt,
  });
  const [reply] = await ctx.db
    .insert(messages)
    .values({
      workspace_id: workspaceId,
      thread_id: thread.id,
      person_id: person.id,
      company_id: person.company_id,
      channel: "email",
      action: "reply",
      direction: "inbound",
      status: "received",
      subject: `Re: ${subject}`,
      body_text: SEEDED_PRIVACY_REPLY,
      from_address: person.email,
      to_address: mailbox?.email ?? null,
      mailbox_id: mailbox?.id ?? null,
      received_at: receivedAt,
      classification: {
        category: "privacy_request",
        privacy_kind: "delete",
        confidence: 1,
        sentiment: "negative",
        summary: "Asked to delete their personal data.",
        source: "rules",
        classified_at: receivedAt.toISOString(),
      },
    })
    .returning();
  if (!reply) return false;

  const note = `Privacy request (reply ${reply.id})`;
  const blocks = [
    { type: "email" as const, value: person.email as string },
    ...(person.linkedin_url ? [{ type: "linkedin" as const, value: person.linkedin_url }] : []),
  ];
  await ctx.db
    .insert(suppressions)
    .values(
      blocks.map((block) => ({
        workspace_id: workspaceId,
        ...block,
        reason: "do_not_contact" as const,
        source: "reply",
        note,
      })),
    )
    .onConflictDoNothing();

  const timeZone = workspace.timezone;
  const name = person.full_name?.trim() || person.email || "Unknown contact";
  const problem = buildPrivacyProblem({
    kind: "delete",
    personId: person.id,
    companyId: person.company_id,
    name,
    label: company ? `${name} (${company.name})` : name,
    firstName: first,
    address: null,
    messageId: reply.id,
    threadId: thread.id,
    receivedAt,
    responseDays: parseWorkspaceSettings(workspace.settings).compliance.privacy_response_days,
    timeZone,
    source: describeDataSource({
      source: person.source,
      emailSource: person.email_source,
      addedAt: person.created_at,
      timeZone,
    }),
  });
  await ctx.db.insert(problems).values({
    workspace_id: workspaceId,
    kind: problem.kind,
    severity: problem.severity,
    owner: problem.owner ?? "person",
    title: problem.title,
    reason: problem.reason,
    remedy: problem.remedy,
    subject_type: problem.subject?.type ?? null,
    subject_id: problem.subject?.id ?? null,
    person_id: problem.personId ?? null,
    company_id: problem.companyId ?? null,
    data: problem.data ?? {},
    due_at: problem.dueAt,
    dedupe_key: problem.dedupeKey ?? null,
    created_at: receivedAt,
  });
  return true;
}
