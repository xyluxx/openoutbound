/**
 * first_party collector: our own records. Event handlers turn bounces and automatic replies
 * that say a person left the company into a job_change signal on that person; the collector
 * pass offers recent inbound messages from the company as evidence for custom signals.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import type { JobContext } from "../../../core/context.js";
import { isOpenOutboundError } from "../../../core/errors.js";
import { onEvent } from "../../../core/events.js";
import { companies, messages, people } from "../../../db/schema/index.js";
import { clip, internalEvidenceUrl } from "../evidence.js";
import { storeSignal } from "../service.js";
import { inWorkspace } from "../workspace-context.js";
import { type Collector, type CollectorOutput, type CollectorRun, emptyOutput } from "./types.js";

/** Phrases (en, de, fr, es, nl) that say someone no longer works at the company. */
export const DEPARTURE_PATTERNS: readonly RegExp[] = [
  /\bno longer (?:with|at|employed|working|works|part of)\b/i,
  /\b(?:has|have) left (?:the|our) (?:company|organi[sz]ation|firm|practice|business|team)\b/i,
  /\bleft the (?:company|organi[sz]ation|firm|practice|business)\b/i,
  /\b(?:my|his|her|their) last day (?:at|with|was)\b/i,
  /\bnot (?:with|at) [^.!?\n]{1,40} any ?more\b/i,
  /\bhas (?:moved on|retired|departed)\b/i,
  /\bnicht mehr (?:bei|im unternehmen|für|in unserem unternehmen|tätig)\b/i,
  /\bhat (?:das unternehmen|uns) verlassen\b/i,
  /\bist aus dem unternehmen ausgeschieden\b/i,
  /\bne fait plus partie\b/i,
  /\ba quitté (?:la société|l'entreprise|le cabinet|notre)\b/i,
  /\bn'est plus (?:en poste|employée?|chez|avec nous)\b/i,
  /\bya no (?:trabaja|forma parte|está) (?:en|con|de)\b/i,
  /\bha dejado la empresa\b/i,
  /\bis niet meer (?:werkzaam|in dienst|bij)\b/i,
];

/** The first sentence that says the person left, clipped to 300 characters; null when none does. */
export function findDepartureSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const sentences = text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (DEPARTURE_PATTERNS.some((pattern) => pattern.test(sentence))) return clip(sentence, 300);
  }
  return null;
}

/** Records job_change on the person (not linked to the old company's intent). */
export async function recordDeparture(
  ctx: JobContext,
  input: {
    personId: string;
    evidenceUrl: string;
    excerpt: string;
    kind: "auto_reply" | "bounce";
    occurredAt: Date;
  },
): Promise<string | null> {
  const workspace = ctx.workspace;
  if (!workspace) return null;
  const [person] = await ctx.db
    .select({
      id: people.id,
      full_name: people.full_name,
      email: people.email,
      company_name: companies.name,
    })
    .from(people)
    .leftJoin(companies, eq(companies.id, people.company_id))
    .where(and(eq(people.workspace_id, workspace.id), eq(people.id, input.personId)));
  if (!person) return null;
  const name = person.full_name ?? person.email ?? "A contact";
  try {
    const result = await storeSignal(
      ctx,
      {
        definition_key: "job_change",
        title: `${name} appears to have left ${person.company_name ?? "their company"}`,
        summary:
          input.kind === "bounce"
            ? "A bounce says this person no longer works there. Find their new company before reaching out again."
            : "An automatic reply says this person no longer works there. Find their new company before reaching out again.",
        evidence_url: input.evidenceUrl,
        evidence_excerpt: input.excerpt,
        source: "first_party",
        occurred_at: input.occurredAt.toISOString(),
        strength: 0.5,
        personId: person.id,
        // One departure per person, however many auto-replies say so.
        dedupe_key: `first_party:departure:${person.id}`,
      },
      { linkPersonCompany: false },
    );
    return result.id;
  } catch (error) {
    // A disabled job_change definition means the workspace does not want these signals.
    if (isOpenOutboundError(error) && error.code === "validation_failed") return null;
    throw error;
  }
}

export const firstPartyReplyHandler = onEvent(
  "reply.received",
  "signals.first_party_reply",
  async (jobCtx, event) => {
    const personId = event.data.person_id;
    if (!personId) return;
    const ctx = await inWorkspace(jobCtx, event.workspaceId);
    if (!ctx) return;
    const [message] = await ctx.db
      .select({ id: messages.id, subject: messages.subject, body_text: messages.body_text })
      .from(messages)
      .where(
        and(eq(messages.workspace_id, event.workspaceId), eq(messages.id, event.data.message_id)),
      );
    if (!message) return;
    const excerpt = findDepartureSentence(`${message.subject ?? ""}\n${message.body_text ?? ""}`);
    if (!excerpt) return;
    await recordDeparture(ctx, {
      personId,
      evidenceUrl: internalEvidenceUrl("messages", message.id),
      excerpt,
      kind: "auto_reply",
      occurredAt: event.occurredAt,
    });
  },
);

export const firstPartyBounceHandler = onEvent(
  "message.bounced",
  "signals.first_party_bounce",
  async (jobCtx, event) => {
    const personId = event.data.person_id;
    if (!personId) return;
    const excerpt = findDepartureSentence(event.data.reason);
    if (!excerpt) return;
    const ctx = await inWorkspace(jobCtx, event.workspaceId);
    if (!ctx) return;
    await recordDeparture(ctx, {
      personId,
      evidenceUrl: internalEvidenceUrl("messages", event.data.message_id ?? `bounce-${event.id}`),
      excerpt,
      kind: "bounce",
      occurredAt: event.occurredAt,
    });
  },
);

const EVIDENCE_DAYS = 90;

export function createFirstPartyCollector(): Collector {
  return {
    name: "first_party",
    async collect(run: CollectorRun): Promise<CollectorOutput> {
      const { ctx, company } = run;
      const since = new Date(ctx.clock.now().getTime() - EVIDENCE_DAYS * 86_400_000);
      const rows = await ctx.db
        .select({
          id: messages.id,
          subject: messages.subject,
          body_text: messages.body_text,
          received_at: messages.received_at,
        })
        .from(messages)
        .where(
          and(
            eq(messages.workspace_id, company.workspace_id),
            eq(messages.company_id, company.id),
            eq(messages.direction, "inbound"),
            gte(messages.received_at, since),
          ),
        )
        .orderBy(desc(messages.received_at))
        .limit(10);
      const output = emptyOutput();
      for (const row of rows) {
        output.evidence.push({
          url: internalEvidenceUrl("messages", row.id),
          title: row.subject ?? "Inbound message",
          text: clip(row.body_text, 800) ?? "",
          published_at: row.received_at?.toISOString() ?? null,
          collector: "first_party",
        });
      }
      return output;
    },
  };
}
