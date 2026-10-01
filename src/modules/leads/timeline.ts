/**
 * One history per person or company, newest first: messages on every channel and campaign,
 * meetings, opportunity stage changes, facts (recorded, corrected, removed, CRM), suppressions,
 * company holds, tasks and enrollments. Built with one query over those tables (and the recent
 * `meeting.*`, `opportunity.updated` and `company.hold_changed` events, with the rows standing in
 * once old events are pruned). Entries never hold message bodies: subjects and summaries only.
 * Binding signature from the upgrade plan (`getTimeline`).
 *
 * Every part reads by an index, never the whole workspace: events by their subject (a meeting,
 * an opportunity or the company; every emitter of these events sets it), messages by person
 * and by company in separate parts.
 */
import { type SQL, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type {
  Channel,
  FactKind,
  FactSource,
  MessageAction,
  ReplyCategory,
} from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "../../core/operation.js";
import { decodeCursor, encodeCursor } from "../../core/pagination.js";
import { queryRows } from "../../db/client.js";
import {
  CATEGORY_WORDS,
  FACT_KIND_LABELS,
  FACT_SOURCE_WORDS,
  formatDay,
  formatMoment,
  stopReasonWords,
} from "./lead-file.js";
import { loadCompany, requireCompany, requirePerson } from "./records.js";

export type TimelineAuthor = "engine" | "person" | "agent" | "prospect" | "system";

export interface TimelineEntry {
  /** ISO 8601. */
  at: string;
  /** Dotted kind, e.g. "message.received", "meeting.booked", "fact.recorded". */
  type: string;
  channel: Channel | null;
  direction: "outbound" | "inbound" | null;
  author: TimelineAuthor;
  /** Plain words, e.g. "Replied: not now", "Meeting booked for 8 Oct, 15:00". */
  title: string;
  /** Subject, summary, source or reason; never a message body. */
  detail: string | null;
  ref: { type: string; id: string } | null;
}

export interface TimelinePage {
  items: TimelineEntry[];
  next_cursor: string | null;
  has_more: boolean;
}

interface Row {
  at: string;
  key: string;
  src: string;
  id: string;
  d: Record<string, unknown> | null;
}

interface Scope {
  workspaceId: string;
  /** Messages, meetings, opportunities, tasks and enrollments of these people. */
  people: SQL;
  personId: string | null;
  companyId: string | null;
  /** Person timeline: company facts of the person's company too. */
  facts: SQL;
  suppressions: SQL;
  /** Disjoint message filters, one indexed part each. */
  messages: SQL[];
  meetings: SQL;
  opportunities: SQL;
  /** Ids of the scope's meetings: their `meeting.*` events are looked up by subject. */
  meetingIds: SQL;
  /** Ids of the scope's opportunities: their `opportunity.updated` events, by subject. */
  opportunityIds: SQL;
}

const invalidInput = (message: string, hint: string) =>
  new OpenOutboundError("validation_failed", message, { hint });

async function resolveScope(
  ctx: OpContext,
  input: { personId?: string; companyId?: string },
): Promise<Scope> {
  const workspace = requireWorkspace(ctx);
  const ws = workspace.id;
  if (input.personId && input.companyId) {
    throw invalidInput(
      "Pass person_id or company_id, not both.",
      "Use person_id for one lead's history, or company_id for everyone at the company.",
    );
  }
  if (input.personId) {
    const person = await requirePerson(ctx, input.personId);
    const company = person.company_id ? await loadCompany(ctx, person.company_id) : null;
    const pid = person.id;
    const cid = company?.id ?? null;
    const suppressionMatches: SQL[] = [sql`(s.type = 'person' and s.value = ${pid})`];
    if (person.email)
      suppressionMatches.push(sql`(s.type = 'email' and s.value = ${person.email})`);
    if (person.linkedin_url) {
      suppressionMatches.push(sql`(s.type = 'linkedin' and s.value = ${person.linkedin_url})`);
    }
    if (cid) suppressionMatches.push(sql`(s.type = 'company' and s.value = ${cid})`);
    if (company?.domain) {
      suppressionMatches.push(sql`(s.type = 'domain' and s.value = ${company.domain})`);
    }
    return {
      workspaceId: ws,
      people: sql`(${pid})`,
      personId: pid,
      companyId: cid,
      facts: cid
        ? sql`((f.scope = 'person' and f.person_id = ${pid}) or (f.scope = 'company' and f.company_id = ${cid}))`
        : sql`(f.scope = 'person' and f.person_id = ${pid})`,
      suppressions: sql.join(suppressionMatches, sql` or `),
      messages: [sql`m.person_id = ${pid}`],
      meetings: sql`mt.person_id = ${pid}`,
      opportunities: sql`o.person_id = ${pid}`,
      meetingIds: sql`(select mt.id from meetings mt where mt.workspace_id = ${ws} and mt.person_id = ${pid})`,
      opportunityIds: sql`(select o.id from opportunities o where o.workspace_id = ${ws} and o.person_id = ${pid})`,
    };
  }
  if (input.companyId) {
    const company = await requireCompany(ctx, input.companyId);
    const cid = company.id;
    const staff = sql`(select p.id from people p where p.workspace_id = ${ws} and p.company_id = ${cid})`;
    const suppressionMatches: SQL[] = [
      sql`(s.type = 'company' and s.value = ${cid})`,
      sql`(s.type = 'person' and s.value in ${staff})`,
      sql`(s.type = 'email' and s.value in (select p.email from people p where p.workspace_id = ${ws} and p.company_id = ${cid} and p.email is not null))`,
      sql`(s.type = 'linkedin' and s.value in (select p.linkedin_url from people p where p.workspace_id = ${ws} and p.company_id = ${cid} and p.linkedin_url is not null))`,
    ];
    if (company.domain) {
      suppressionMatches.push(sql`(s.type = 'domain' and s.value = ${company.domain})`);
    }
    return {
      workspaceId: ws,
      people: staff,
      personId: null,
      companyId: cid,
      facts: sql`f.company_id = ${cid}`,
      suppressions: sql.join(suppressionMatches, sql` or `),
      // The company's messages, then its people's messages filed under no or another company.
      messages: [
        sql`m.company_id = ${cid}`,
        sql`m.person_id in ${staff} and m.company_id is distinct from ${cid}`,
      ],
      meetings: sql`(mt.company_id = ${cid} or mt.person_id in ${staff})`,
      opportunities: sql`(o.company_id = ${cid} or o.person_id in ${staff})`,
      meetingIds: sql`(select mt.id from meetings mt where mt.workspace_id = ${ws} and (mt.company_id = ${cid} or mt.person_id in ${staff}))`,
      opportunityIds: sql`(select o.id from opportunities o where o.workspace_id = ${ws} and (o.company_id = ${cid} or o.person_id in ${staff}))`,
    };
  }
  throw invalidInput(
    "Say whose timeline to read.",
    "Pass person_id (one lead) or company_id (everyone at the company).",
  );
}

/** One SELECT per kind of entry; every branch returns (at, key, src, id, d). */
function branches(scope: Scope): SQL[] {
  const ws = scope.workspaceId;
  const noEvent = (type: SQL, meetingId: SQL) =>
    sql`not exists (select 1 from events x where x.workspace_id = ${ws} and x.subject_type = 'meeting' and x.subject_id = ${meetingId} and x.type = (${type}))`;
  const messageParts = scope.messages.map(
    (filter) =>
      sql`select date_trunc('milliseconds', coalesce(case when m.direction = 'inbound' then m.received_at else m.sent_at end, m.created_at)) as at,
        'msg:' || m.id as key, 'message'::text as src, m.id as id,
        jsonb_build_object('direction', m.direction, 'channel', m.channel, 'action', m.action,
          'status', m.status, 'origin', m.origin, 'subject', m.subject,
          'category', m.classification->>'category', 'summary', m.classification->>'summary',
          'suspicious', coalesce(m.classification->>'suspicious', 'false'),
          'campaign_name', c.name) as d
      from messages m left join campaigns c on c.id = m.campaign_id
      where m.workspace_id = ${ws} and ${filter}
        and (m.direction = 'inbound' or m.status in ('sent', 'bounced'))`,
  );
  const out: SQL[] = [
    ...messageParts,
    sql`select date_trunc('milliseconds', e.occurred_at) as at, 'mev:' || e.id as key,
        'meeting_event'::text as src, e.id as id,
        jsonb_build_object('type', e.type, 'data', e.data) as d
      from events e
      where e.workspace_id = ${ws} and e.subject_type = 'meeting'
        and e.subject_id in ${scope.meetingIds}
        and e.type in ('meeting.booked', 'meeting.rescheduled', 'meeting.cancelled', 'meeting.no_show', 'meeting.held')`,
    sql`select date_trunc('milliseconds', mt.created_at) as at, 'mtb:' || mt.id as key,
        'meeting_booked_row'::text as src, mt.id as id,
        jsonb_build_object('start_at', mt.start_at, 'source', mt.source, 'actor', mt.created_by->>'type') as d
      from meetings mt
      where mt.workspace_id = ${ws} and ${scope.meetings}
        and ${noEvent(sql`'meeting.booked'`, sql`mt.id`)}`,
    sql`select date_trunc('milliseconds', coalesce(mt.status_changed_at, mt.updated_at)) as at,
        'mts:' || mt.id as key, 'meeting_status_row'::text as src, mt.id as id,
        jsonb_build_object('status', mt.status, 'qualified', mt.qualified, 'start_at', mt.start_at) as d
      from meetings mt
      where mt.workspace_id = ${ws} and ${scope.meetings}
        and mt.status in ('held', 'no_show', 'cancelled')
        and ${noEvent(sql`'meeting.' || mt.status`, sql`mt.id`)}`,
    sql`select date_trunc('milliseconds', e.occurred_at) as at, 'oev:' || e.id as key,
        'opportunity_event'::text as src, e.id as id,
        jsonb_build_object('opportunity_id', e.data->>'opportunity_id', 'stage', e.data->>'stage',
          'previous_stage', e.data->>'previous_stage') as d
      from events e
      where e.workspace_id = ${ws} and e.subject_type = 'opportunity'
        and e.subject_id in ${scope.opportunityIds}
        and e.type = 'opportunity.updated'
        and (e.data->>'stage') is distinct from (e.data->>'previous_stage')`,
    sql`select date_trunc('milliseconds', o.created_at) as at, 'opo:' || o.id as key,
        'opportunity_opened_row'::text as src, o.id as id, '{}'::jsonb as d
      from opportunities o
      where o.workspace_id = ${ws} and ${scope.opportunities}
        and not exists (select 1 from events x where x.workspace_id = ${ws}
          and x.subject_type = 'opportunity' and x.subject_id = o.id
          and x.type = 'opportunity.updated' and (x.data->>'previous_stage') is null)`,
    sql`select date_trunc('milliseconds', o.closed_at) as at, 'opc:' || o.id as key,
        'opportunity_closed_row'::text as src, o.id as id,
        jsonb_build_object('stage', o.stage, 'lost_reason', o.lost_reason) as d
      from opportunities o
      where o.workspace_id = ${ws} and ${scope.opportunities}
        and o.stage in ('won', 'lost') and o.closed_at is not null
        and not exists (select 1 from events x where x.workspace_id = ${ws}
          and x.subject_type = 'opportunity' and x.subject_id = o.id
          and x.type = 'opportunity.updated' and (x.data->>'stage') = o.stage
          and (x.data->>'previous_stage') is distinct from o.stage)`,
    sql`select date_trunc('milliseconds', f.observed_at) as at, 'fct:' || f.id as key,
        'fact_recorded'::text as src, f.id as id,
        jsonb_build_object('kind', f.kind, 'scope', f.scope, 'text', f.text, 'source', f.source,
          'source_ref', f.source_ref) as d
      from lead_facts f
      where f.workspace_id = ${ws} and ${scope.facts}`,
    sql`select date_trunc('milliseconds', f.updated_at) as at, 'fcs:' || f.id as key,
        'fact_changed'::text as src, f.id as id,
        jsonb_build_object('kind', f.kind, 'scope', f.scope, 'text', f.text, 'status', f.status,
          'new_text', (select r.text from lead_facts r where r.workspace_id = ${ws} and r.id = f.replaced_by)) as d
      from lead_facts f
      where f.workspace_id = ${ws} and ${scope.facts} and f.status in ('corrected', 'removed')`,
    sql`select date_trunc('milliseconds', s.created_at) as at, 'sup:' || s.id as key,
        'suppression'::text as src, s.id as id,
        jsonb_build_object('type', s.type, 'reason', s.reason) as d
      from suppressions s
      where s.workspace_id = ${ws} and (${scope.suppressions})`,
    sql`select date_trunc('milliseconds', t.created_at) as at, 'tkn:' || t.id as key,
        'task_created'::text as src, t.id as id,
        jsonb_build_object('type', t.type, 'title', t.title, 'auto', t.dedupe_key is not null,
          'due_at', t.due_at) as d
      from tasks t
      where t.workspace_id = ${ws} and t.person_id in ${scope.people}`,
    sql`select date_trunc('milliseconds', t.completed_at) as at, 'tke:' || t.id as key,
        'task_ended'::text as src, t.id as id,
        jsonb_build_object('type', t.type, 'title', t.title, 'status', t.status) as d
      from tasks t
      where t.workspace_id = ${ws} and t.person_id in ${scope.people}
        and t.status in ('done', 'skipped') and t.completed_at is not null`,
    sql`select date_trunc('milliseconds', n.enrolled_at) as at, 'ens:' || n.id as key,
        'enrollment_started'::text as src, n.id as id,
        jsonb_build_object('campaign_name', c.name) as d
      from enrollments n left join campaigns c on c.id = n.campaign_id
      where n.workspace_id = ${ws} and n.person_id in ${scope.people}`,
    sql`select date_trunc('milliseconds', n.completed_at) as at, 'ene:' || n.id as key,
        'enrollment_ended'::text as src, n.id as id,
        jsonb_build_object('campaign_name', c.name, 'status', n.status, 'stop_reason', n.stop_reason) as d
      from enrollments n left join campaigns c on c.id = n.campaign_id
      where n.workspace_id = ${ws} and n.person_id in ${scope.people}
        and n.status in ('completed', 'stopped', 'failed') and n.completed_at is not null`,
  ];
  if (scope.companyId) {
    out.push(
      sql`select date_trunc('milliseconds', e.occurred_at) as at, 'hev:' || e.id as key,
          'hold_event'::text as src, e.id as id,
          jsonb_build_object('hold_until', e.data->>'hold_until', 'reason', e.data->>'reason',
            'company_id', e.data->>'company_id') as d
        from events e
        where e.workspace_id = ${ws} and e.subject_type = 'company'
          and e.subject_id = ${scope.companyId} and e.type = 'company.hold_changed'`,
    );
  }
  return out;
}

// --- Rendering -------------------------------------------------------------------------------

const SENT_TITLES: Record<MessageAction, string> = {
  email: "Email sent",
  reply: "Reply sent",
  invite: "LinkedIn invite sent",
  message: "LinkedIn message sent",
  comment: "LinkedIn comment posted",
  like: "LinkedIn post liked",
  visit: "LinkedIn profile visited",
};

const STAGE_WORDS: Record<string, string> = {
  interested: "interested",
  meeting_booked: "meeting booked",
  won: "won",
  lost: "lost",
};

const SUPPRESSION_WORDS: Record<string, string> = {
  email: "Email address blocked",
  domain: "Whole domain blocked",
  linkedin: "LinkedIn profile blocked",
  person: "Person blocked",
  company: "Company blocked",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function date(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function joined(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part?.trim()));
  return kept.length > 0 ? kept.join("; ") : null;
}

function capitalize(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function authorOfActor(type: unknown): TimelineAuthor {
  if (type === "agent") return "agent";
  if (type === "human") return "person";
  return "system";
}

const FACT_AUTHORS: Record<FactSource, TimelineAuthor> = {
  reply: "engine",
  manual: "person",
  agent: "agent",
  crm: "system",
  research: "engine",
};

interface RenderContext {
  zone: string;
  now: Date;
}

function meetingEntry(
  status: string,
  data: Record<string, unknown>,
  render: RenderContext,
): Pick<TimelineEntry, "title" | "detail"> {
  const start = date(data.start_at);
  const when = start ? formatMoment(start, render.zone, render.now) : null;
  switch (status) {
    case "booked":
      return {
        title: when ? `Meeting booked for ${when}` : "Meeting booked",
        detail: joined([
          text(data.source) ? `Source: ${text(data.source)}` : null,
          when ? `Times in ${render.zone}` : null,
        ]),
      };
    case "rescheduled": {
      const before = date(data.previous_start_at);
      return {
        title: when ? `Meeting moved to ${when}` : "Meeting moved",
        detail: before
          ? `Was ${formatMoment(before, render.zone, render.now)} (${render.zone})`
          : null,
      };
    }
    case "cancelled":
      return { title: "Meeting cancelled", detail: when ? `It was set for ${when}` : null };
    case "no_show":
      return { title: "Meeting missed (no-show)", detail: when ? `Set for ${when}` : null };
    default: {
      const qualified =
        data.qualified === true
          ? " (qualified)"
          : data.qualified === false
            ? " (not qualified)"
            : "";
      return { title: `Meeting held${qualified}`, detail: when ? `Started ${when}` : null };
    }
  }
}

function toEntry(row: Row, render: RenderContext): TimelineEntry {
  const d = row.d ?? {};
  const base = { at: new Date(row.at).toISOString(), channel: null, direction: null };
  switch (row.src) {
    case "message": {
      const channel = (text(d.channel) ?? "email") as Channel;
      if (d.direction === "inbound") {
        const category = text(d.category) as ReplyCategory | null;
        const words = category ? CATEGORY_WORDS[category] : null;
        return {
          ...base,
          type: "message.received",
          channel,
          direction: "inbound",
          author: "prospect",
          title: words ? `Replied: ${words}` : "Replied",
          detail:
            d.suspicious === "true"
              ? "Flagged: the reply tried to instruct an AI. Read the thread before acting on it."
              : (text(d.summary) ?? (text(d.subject) ? `Subject: ${text(d.subject)}` : null)),
          ref: { type: "message", id: row.id },
        };
      }
      const bounced = d.status === "bounced";
      const action = (text(d.action) ?? "email") as MessageAction;
      return {
        ...base,
        type: bounced ? "message.bounced" : "message.sent",
        channel,
        direction: "outbound",
        author: bounced ? "system" : d.origin === "external" ? "person" : "engine",
        title: bounced ? "Email bounced" : (SENT_TITLES[action] ?? "Message sent"),
        detail: joined([
          text(d.subject) ? `Subject: ${text(d.subject)}` : null,
          text(d.campaign_name) ? `Campaign: ${text(d.campaign_name)}` : null,
          d.origin === "external" ? "Written by a person outside the engine" : null,
        ]),
        ref: { type: "message", id: row.id },
      };
    }
    case "meeting_event": {
      const type = text(d.type) ?? "meeting.booked";
      const data = (d.data ?? {}) as Record<string, unknown>;
      const status = type.slice("meeting.".length);
      const source = text(data.source);
      const author: TimelineAuthor =
        status !== "booked" ? "system" : source === "manual" ? "person" : "prospect";
      return {
        ...base,
        type,
        author,
        ...meetingEntry(status, data, render),
        ref: text(data.meeting_id)
          ? { type: "meeting", id: text(data.meeting_id) as string }
          : null,
      };
    }
    case "meeting_booked_row": {
      const source = text(d.source);
      return {
        ...base,
        type: "meeting.booked",
        author: source === "manual" ? authorOfActor(d.actor) : "prospect",
        ...meetingEntry("booked", d, render),
        ref: { type: "meeting", id: row.id },
      };
    }
    case "meeting_status_row": {
      const status = text(d.status) ?? "held";
      return {
        ...base,
        type: `meeting.${status}`,
        author: "system",
        ...meetingEntry(status, d, render),
        ref: { type: "meeting", id: row.id },
      };
    }
    case "opportunity_event": {
      const stage = text(d.stage) ?? "interested";
      const previous = text(d.previous_stage);
      const id = text(d.opportunity_id);
      const words = STAGE_WORDS[stage] ?? stage;
      const type = !previous
        ? "opportunity.opened"
        : stage === "won" || stage === "lost"
          ? `opportunity.${stage}`
          : "opportunity.stage_changed";
      const title = !previous
        ? `Opportunity opened (${words})`
        : stage === "won"
          ? "Deal won"
          : stage === "lost"
            ? "Deal lost"
            : `Opportunity moved to ${words}`;
      return {
        ...base,
        type,
        author: "system",
        title,
        detail: previous ? `Was ${STAGE_WORDS[previous] ?? previous}` : null,
        ref: id ? { type: "opportunity", id } : null,
      };
    }
    case "opportunity_opened_row":
      return {
        ...base,
        type: "opportunity.opened",
        author: "system",
        title: "Opportunity opened",
        detail: null,
        ref: { type: "opportunity", id: row.id },
      };
    case "opportunity_closed_row": {
      const won = d.stage === "won";
      return {
        ...base,
        type: won ? "opportunity.won" : "opportunity.lost",
        author: "system",
        title: won ? "Deal won" : "Deal lost",
        detail: won ? null : text(d.lost_reason) ? `Reason: ${text(d.lost_reason)}` : null,
        ref: { type: "opportunity", id: row.id },
      };
    }
    case "fact_recorded": {
      const source = (text(d.source) ?? "manual") as FactSource;
      const kind = (text(d.kind) ?? "fact") as FactKind;
      const company = d.scope === "company";
      return {
        ...base,
        type: source === "crm" ? "crm.fact" : kind === "note" ? "note.added" : "fact.recorded",
        author: FACT_AUTHORS[source] ?? "system",
        title: `${source === "crm" ? "CRM" : FACT_KIND_LABELS[kind]}: ${text(d.text) ?? ""}`,
        detail: capitalize(
          joined([
            company ? "about the company" : null,
            `${FACT_SOURCE_WORDS[source]}${source === "crm" && text(d.source_ref) ? ` (${text(d.source_ref)})` : ""}`,
          ]) ?? "",
        ),
        ref: { type: "fact", id: row.id },
      };
    }
    case "fact_changed": {
      const kind = (text(d.kind) ?? "fact") as FactKind;
      const corrected = d.status === "corrected";
      return {
        ...base,
        type: corrected ? "fact.corrected" : "fact.removed",
        author: "system",
        title: `${FACT_KIND_LABELS[kind]} ${corrected ? "corrected" : "removed"}: ${text(d.text) ?? ""}`,
        detail: corrected && text(d.new_text) ? `Now: ${text(d.new_text)}` : null,
        ref: { type: "fact", id: row.id },
      };
    }
    case "suppression": {
      const reason = text(d.reason) ?? "manual";
      return {
        ...base,
        type: "suppression.added",
        author: "system",
        title: `Suppressed: ${reason.replace(/_/g, " ")}`,
        detail: SUPPRESSION_WORDS[text(d.type) ?? ""] ?? null,
        ref: { type: "suppression", id: row.id },
      };
    }
    case "hold_event": {
      const until = date(d.hold_until);
      return {
        ...base,
        type: "company.hold_changed",
        author: "system",
        title: until
          ? `Company on hold until ${formatDay(until, render.zone)}`
          : "Company hold lifted",
        detail: text(d.reason),
        ref: text(d.company_id) ? { type: "company", id: text(d.company_id) as string } : null,
      };
    }
    case "task_created": {
      const due = date(d.due_at);
      return {
        ...base,
        type: "task.created",
        author: d.auto === true ? "engine" : "person",
        title: `${d.type === "promise" ? "Promise" : "Task"}: ${text(d.title) ?? ""}`,
        detail: due ? `Due ${formatMoment(due, render.zone, render.now)}` : null,
        ref: { type: "task", id: row.id },
      };
    }
    case "task_ended": {
      const done = d.status === "done";
      return {
        ...base,
        type: done ? "task.done" : "task.skipped",
        author: "person",
        title: `${d.type === "promise" ? "Promise" : "Task"} ${done ? "done" : "skipped"}: ${text(d.title) ?? ""}`,
        detail: null,
        ref: { type: "task", id: row.id },
      };
    }
    case "enrollment_started":
      return {
        ...base,
        type: "enrollment.started",
        author: "engine",
        title: `Added to campaign ${text(d.campaign_name) ?? "(deleted)"}`,
        detail: null,
        ref: { type: "enrollment", id: row.id },
      };
    default: {
      const status = text(d.status) ?? "stopped";
      const name = text(d.campaign_name) ?? "(deleted)";
      const title =
        status === "completed"
          ? `Finished campaign ${name}`
          : status === "failed"
            ? `Campaign ${name} failed`
            : `Stopped in campaign ${name}`;
      return {
        ...base,
        type: `enrollment.${status}`,
        author: "engine",
        title,
        detail: status === "completed" ? null : capitalize(stopReasonWords(text(d.stop_reason))),
        ref: { type: "enrollment", id: row.id },
      };
    }
  }
}

/**
 * The history of a person (`personId`) or a company (`companyId`, everyone there), newest
 * first. `limit` default 25, max 100. The cursor holds the last entry's time and key, so pages
 * stay stable when several entries share a timestamp.
 */
export async function getTimeline(
  ctx: OpContext,
  input: { personId?: string; companyId?: string; limit?: number; cursor?: string | null },
): Promise<TimelinePage> {
  const workspace = requireWorkspace(ctx);
  const scope = await resolveScope(ctx, input);
  const limit = Math.max(
    1,
    Math.min(Math.trunc(input.limit ?? PAGE_LIMIT_DEFAULT), PAGE_LIMIT_MAX),
  );
  let after: SQL | null = null;
  if (input.cursor) {
    const cursor = decodeCursor<{ t?: unknown; k?: unknown }>(input.cursor);
    const t = typeof cursor.t === "string" ? new Date(cursor.t) : null;
    if (!t || Number.isNaN(t.getTime()) || typeof cursor.k !== "string") {
      throw invalidInput(
        "Invalid cursor.",
        "Pass next_cursor exactly as returned by the previous page, or omit it to start over.",
      );
    }
    const at = sql`${t.toISOString()}::timestamptz`;
    after = sql`and (u.at < ${at} or (u.at = ${at} and u.key collate "C" < ${cursor.k}))`;
  }
  const rows = await queryRows<Row>(
    ctx.db,
    sql`select to_char(u.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
        u.key, u.src, u.id, u.d
      from (${sql.join(branches(scope), sql` union all `)}) u
      where u.at is not null ${after ?? sql``}
      order by u.at desc, u.key collate "C" desc
      limit ${limit + 1}`,
  );
  const render: RenderContext = { zone: workspace.timezone || "UTC", now: ctx.clock.now() };
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((row) => toEntry(row, render)),
    next_cursor: hasMore && last ? encodeCursor({ t: last.at, k: last.key }) : null,
    has_more: hasMore,
  };
}
