import { and, asc, eq, inArray } from "drizzle-orm";
import { wrapUntrusted } from "../../../brain/prompt.js";
import type { OpContext } from "../../../core/context.js";
import { requireWorkspace } from "../../../core/context.js";
import {
  type CampaignSettings,
  parseWorkspaceSettings,
  type WorkspaceSettings,
} from "../../../core/settings.js";
import {
  type Campaign,
  type Company,
  linkedin_accounts,
  type Message,
  mailboxes,
  messages,
  type Person,
  type ResearchBriefRow,
} from "../../../db/schema/index.js";
import { bookingLinkFor } from "../../inbox/booking-links.js";
import { buildGroundingPack, type GroundingPack } from "../../knowledge/service.js";
import { LEAD_FILE_SOURCE, wrappedLeadContext } from "../../leads/service.js";
import { getLatestBrief } from "../../research/service.js";
import { getActiveSignals, type SignalWithScore } from "../../signals/service.js";
import type { TemplateVars } from "./render.js";

/** Everything the writing pipeline knows about one lead in one campaign. */
export interface WritingContext {
  person: Person;
  company: Company | null;
  campaign: Campaign;
  settings: CampaignSettings;
  workspaceSettings: WorkspaceSettings;
  brief: ResearchBriefRow | null;
  signals: SignalWithScore[];
  grounding: GroundingPack;
  senderName: string | null;
  senderCompany: string | null;
  /** Our earlier sent messages to this person in this enrollment, oldest first. */
  history: Message[];
  language: string;
  /** URLs, knowledge ids, the offer id, "record" and "lead_file": what facts may cite. */
  allowedSources: Set<string>;
  allowedSignalIds: Set<string>;
  /** Text numbers must come from (grounding + research + signals + record). */
  evidenceText: string;
  vars: TemplateVars;
  rendered: {
    prospect: string;
    brief: string | null;
    signals: string | null;
    history: string | null;
    /** What we know from earlier conversations (the lead file), wrapped as untrusted. */
    lead_context: string | null;
    /** Brief facts and signals with sources, for the checker. */
    evidence: string;
  };
}

export interface BuildContextInput {
  campaign: Campaign;
  settings: CampaignSettings;
  person: Person;
  company: Company | null;
  enrollmentId?: string | null;
  mailboxId?: string | null;
  linkedinAccountId?: string | null;
  channel: "email" | "linkedin";
}

const GROUNDING_MAX_CHARS = 6000;

function line(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return `${label}: ${String(value)}`;
}

function renderProspect(person: Person, company: Company | null): string {
  const lines = [
    line("Name", person.full_name ?? [person.first_name, person.last_name].join(" ").trim()),
    line("Title", person.title),
    line("Seniority", person.seniority),
    line("Department", person.department),
    line("City", person.city),
    line("Country", person.country),
    line("Company", company?.name),
    line("Company website", company?.website),
    line("Industry", company?.industry),
    line("Employees", company?.employee_count ?? company?.employee_range),
    line("Company city", company?.city),
    line("Company description", company?.description),
  ].filter((value): value is string => value !== null);
  return wrapUntrusted("prospect record", lines.join("\n"));
}

function renderBrief(row: ResearchBriefRow | null): string | null {
  const brief = row?.brief;
  if (!brief) return null;
  const lines: string[] = [];
  if (brief.who?.summary) lines.push(`Who: ${brief.who.summary}`);
  if (brief.company?.summary) lines.push(`Company: ${brief.company.summary}`);
  for (const fact of brief.now ?? []) {
    lines.push(
      `Fact: ${fact.fact} (source: ${fact.source_url}${fact.date ? `, ${fact.date}` : ""})`,
    );
  }
  for (const pain of brief.pains ?? []) {
    lines.push(`Pain hypothesis: ${pain.hypothesis} (evidence: ${pain.evidence_urls.join(", ")})`);
  }
  for (const angle of brief.angles ?? []) {
    lines.push(`Angle: ${angle.angle}: ${angle.why} (evidence: ${angle.evidence_urls.join(", ")})`);
  }
  if (brief.recommended_angle) lines.push(`Recommended angle: ${brief.recommended_angle}`);
  lines.push(`Confidence: ${brief.confidence}`);
  return wrapUntrusted("research brief", lines.join("\n"));
}

function renderSignals(signals: SignalWithScore[]): string | null {
  if (signals.length === 0) return null;
  const lines = signals.map((signal) =>
    [
      `id: ${signal.id}`,
      `type: ${signal.definition_key}`,
      `title: ${signal.title}`,
      signal.summary ? `summary: ${signal.summary}` : null,
      signal.evidence_url ? `evidence: ${signal.evidence_url}` : null,
      signal.evidence_excerpt ? `excerpt: ${signal.evidence_excerpt}` : null,
      signal.occurred_at
        ? `date: ${new Date(signal.occurred_at).toISOString().slice(0, 10)}`
        : null,
      `age_days: ${Math.round(signal.age_days)}`,
    ]
      .filter(Boolean)
      .join("; "),
  );
  return wrapUntrusted("signals", lines.join("\n"));
}

function renderHistory(history: Message[]): string | null {
  if (history.length === 0) return null;
  return history
    .map((message, index) => {
      const when = message.sent_at ? message.sent_at.toISOString().slice(0, 10) : "not sent";
      const subject = message.subject ? `Subject: ${message.subject}\n` : "";
      return `Message ${index + 1} (${message.channel} ${message.action}, ${when}):\n${subject}${message.body_text ?? ""}`;
    })
    .join("\n\n");
}

async function topSignals(ctx: OpContext, person: Person): Promise<SignalWithScore[]> {
  const lists = await Promise.all([
    person.company_id
      ? getActiveSignals(ctx, { companyId: person.company_id, limit: 5 })
      : Promise.resolve([]),
    getActiveSignals(ctx, { personId: person.id, limit: 5 }),
  ]);
  const byId = new Map<string, SignalWithScore>();
  for (const signal of lists.flat()) byId.set(signal.id, signal);
  return [...byId.values()].sort((a, b) => b.current_score - a.current_score).slice(0, 3);
}

async function senderFor(
  ctx: OpContext,
  input: BuildContextInput,
): Promise<{ name: string | null }> {
  const workspace = requireWorkspace(ctx);
  if (input.channel === "linkedin") {
    const ids = input.linkedinAccountId
      ? [input.linkedinAccountId]
      : input.settings.senders.linkedin_account_ids;
    if (ids.length === 0) return { name: null };
    const [account] = await ctx.db
      .select({ name: linkedin_accounts.name })
      .from(linkedin_accounts)
      .where(
        and(eq(linkedin_accounts.workspace_id, workspace.id), inArray(linkedin_accounts.id, ids)),
      )
      .limit(1);
    return { name: account?.name ?? null };
  }
  const ids = input.mailboxId ? [input.mailboxId] : input.settings.senders.mailbox_ids;
  if (ids.length === 0) return { name: null };
  const [mailbox] = await ctx.db
    .select({ from_name: mailboxes.from_name })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspace_id, workspace.id), inArray(mailboxes.id, ids)))
    .limit(1);
  return { name: mailbox?.from_name ?? null };
}

/** Sent outbound messages of the enrollment, oldest first. */
export async function enrollmentHistory(
  ctx: OpContext,
  enrollmentId: string | null | undefined,
): Promise<Message[]> {
  if (!enrollmentId) return [];
  const workspace = requireWorkspace(ctx);
  return ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.enrollment_id, enrollmentId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
      ),
    )
    .orderBy(asc(messages.sent_at), asc(messages.id));
}

/**
 * Gathers the lead context for writing: latest research brief, top 3 active signals, the
 * grounding pack for the campaign offer, sender, language, earlier messages and what we know
 * from earlier conversations (the lead file). Untrusted parts are wrapped for prompts here.
 */
export async function buildWritingContext(
  ctx: OpContext,
  input: BuildContextInput,
): Promise<WritingContext> {
  const workspace = requireWorkspace(ctx);
  const workspaceSettings = parseWorkspaceSettings(workspace.settings);
  const { person, company, campaign, settings } = input;

  const [brief, signals, history, sender, leadContext] = await Promise.all([
    getLatestBrief(ctx, { personId: person.id }),
    topSignals(ctx, person),
    enrollmentHistory(ctx, input.enrollmentId),
    senderFor(ctx, input),
    wrappedLeadContext(ctx, person.id),
  ]);
  const query = [
    brief?.brief?.recommended_angle,
    company?.industry,
    person.title,
    settings.writing.instructions,
  ]
    .filter(Boolean)
    .join(" ");
  const grounding = await buildGroundingPack(ctx, {
    offerId: campaign.offer_id,
    query,
    maxChars: GROUNDING_MAX_CHARS,
  });

  const allowedSources = new Set<string>(["record"]);
  if (leadContext) allowedSources.add(LEAD_FILE_SOURCE);
  const briefData = brief?.brief;
  for (const fact of briefData?.now ?? []) allowedSources.add(fact.source_url);
  for (const pain of briefData?.pains ?? [])
    for (const url of pain.evidence_urls) allowedSources.add(url);
  for (const angle of briefData?.angles ?? []) {
    for (const url of angle.evidence_urls) allowedSources.add(url);
  }
  for (const source of brief?.sources ?? []) allowedSources.add(source.url);
  for (const signal of signals) if (signal.evidence_url) allowedSources.add(signal.evidence_url);
  for (const fact of grounding.facts) allowedSources.add(fact.id);
  if (grounding.offer) allowedSources.add(grounding.offer.id);
  if (campaign.offer_id) allowedSources.add(campaign.offer_id);

  const rendered = {
    prospect: renderProspect(person, company),
    brief: renderBrief(brief),
    signals: renderSignals(signals),
    history: renderHistory(history),
    lead_context: leadContext,
    evidence: [
      renderBrief(brief),
      renderSignals(signals),
      renderProspect(person, company),
      leadContext,
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const evidenceText = [
    grounding.text,
    JSON.stringify(briefData ?? {}),
    ...signals.map(
      (signal) => `${signal.title} ${signal.summary ?? ""} ${signal.evidence_excerpt ?? ""}`,
    ),
    rendered.prospect,
    leadContext ?? "",
  ].join("\n");

  const language = settings.writing.language ?? person.language ?? workspaceSettings.ai.language;
  const senderCompany = workspaceSettings.company.name || grounding.company.name || null;
  // `{{booking_url}}` in a step: the offer's link (else booking.default_url), in every booking
  // mode, with the person's hidden booking code on Calendly and Cal.com links.
  const bookingUrl = await bookingLinkFor(ctx, {
    personId: person.id,
    offerUrl: grounding.offer?.booking_url ?? null,
    purpose: "template",
  });

  return {
    person,
    company,
    campaign,
    settings,
    workspaceSettings,
    brief,
    signals,
    grounding,
    senderName: sender.name,
    senderCompany,
    history,
    language,
    allowedSources,
    allowedSignalIds: new Set(signals.map((signal) => signal.id)),
    evidenceText,
    vars: {
      first_name: person.first_name,
      last_name: person.last_name,
      company: company?.name ?? null,
      title: person.title,
      city: person.city ?? company?.city ?? null,
      sender_name: sender.name,
      offer: grounding.offer?.name ?? null,
      booking_url: bookingUrl,
      custom: { ...(company?.custom ?? {}), ...(person.custom ?? {}) },
    },
    rendered,
  };
}
