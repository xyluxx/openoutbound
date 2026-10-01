/**
 * The relationship view: where a person stands (one state, since when), what happens next, what
 * blocks it (the senders' own checks) and whether it is stuck. Computed from existing records;
 * nothing is stored.
 */
import type { OpContext } from "../../core/context.js";
import type { ReplyCategory } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { WorkspaceSettings } from "../../core/settings.js";
import { stepAction } from "../campaigns/steps.js";
import { isValidTimeZone } from "../email/timezone.js";
import { type Blocker, blocker, uniqueBlockers, withoutTimingWaits } from "./blockers.js";
import { checkEligibilityMany, personName } from "./eligibility.js";
import { EligibilityLoader } from "./eligibility-loader.js";
import type { EligibilityInput } from "./eligibility-types.js";
import { type NextAction, pickNextAction } from "./next-action.js";
import { loadRelationshipFacts, type RelationshipFacts } from "./relationship-data.js";
import { stuckForPerson } from "./stuck.js";

export const RELATIONSHIP_STATES = [
  "new",
  "in_sequence",
  "waiting",
  "in_conversation",
  "meeting_scheduled",
  "meeting_held",
  "won",
  "lost",
  "not_now",
  "stopped",
  "finished",
] as const;
export type RelationshipState = (typeof RELATIONSHIP_STATES)[number];

export type { NextAction } from "./next-action.js";

/** Binding shape from the upgrade plan. */
export interface RelationshipView {
  person_id: string;
  company_id: string | null;
  opportunity_id: string | null;
  state: RelationshipState;
  state_since: string | null;
  next_action: NextAction | null;
  blockers: Blocker[];
  stuck: boolean;
  stuck_reason: string | null;
}

/** Replies that keep a conversation going (unclassified replies count too). */
const CONVERSATION_CATEGORIES: ReadonlySet<ReplyCategory> = new Set([
  "interested",
  "meeting_request",
  "question",
  "objection",
  "other",
]);

const HOUR_MS = 3_600_000;

function earliest(dates: Array<Date | null | undefined>): Date | null {
  const times = dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

function latest(dates: Array<Date | null | undefined>): Date | null {
  const times = dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}

interface Decided {
  state: RelationshipState;
  since: Date | null;
}

/** The state by precedence, with the time of the record that set it. */
export function decideState(
  facts: RelationshipFacts,
  now: Date,
  settings: WorkspaceSettings,
): Decided {
  const { person, company } = facts;

  const stops: Date[] = facts.suppressions.map((row) => row.created_at);
  if (["do_not_contact", "unsubscribed", "bounced"].includes(person.status)) {
    stops.push(person.updated_at);
  }
  if (company?.status === "do_not_contact") stops.push(company.updated_at);
  stops.push(...facts.privacy.map((row) => row.created_at));
  if (stops.length > 0) return { state: "stopped", since: earliest(stops) };

  const won = facts.opportunities.find((row) => row.stage === "won");
  if (won) return { state: "won", since: won.closed_at ?? won.updated_at };
  if (person.status === "customer") return { state: "won", since: person.updated_at };

  const assumeMs = settings.booking.assume_held_after_hours * HOUR_MS;
  if (facts.meetings.length > 0) {
    const scheduled = facts.meetings.filter((row) => row.status === "scheduled");
    const assumed = scheduled.filter(
      (row) => assumeMs > 0 && row.start_at && row.start_at.getTime() + assumeMs <= now.getTime(),
    );
    const upcoming = scheduled.filter((row) => !assumed.includes(row));
    if (upcoming.length > 0) {
      return { state: "meeting_scheduled", since: earliest(upcoming.map((row) => row.created_at)) };
    }
    const held = facts.meetings.filter((row) => row.status === "held");
    if (held.length > 0 || assumed.length > 0) {
      return {
        state: "meeting_held",
        since: latest([
          ...held.map((row) => row.status_changed_at ?? row.start_at),
          ...assumed.map((row) =>
            row.start_at ? new Date(row.start_at.getTime() + assumeMs) : null,
          ),
        ]),
      };
    }
  } else {
    const booked = facts.opportunities.find((row) => row.stage === "meeting_booked");
    if (booked) {
      if (!booked.meeting_at || booked.meeting_at > now) {
        return { state: "meeting_scheduled", since: booked.updated_at };
      }
      return { state: "meeting_held", since: booked.meeting_at };
    }
  }

  const owned = facts.threads.find((row) => row.owner === "person");
  const talking = facts.threads.find(
    (row) =>
      row.latest_direction === "inbound" &&
      (row.latest_category === null || CONVERSATION_CATEGORIES.has(row.latest_category)),
  );
  const interested = facts.opportunities.find((row) => row.stage === "interested");
  if (talking) return { state: "in_conversation", since: talking.latest_at };
  if (owned) return { state: "in_conversation", since: owned.owner_changed_at };
  if (interested) return { state: "in_conversation", since: interested.created_at };

  const reply = facts.latestReply;
  if (
    reply?.category === "not_now" &&
    facts.tasks.some((task) => task.type === "follow_up" && task.status === "open")
  ) {
    return { state: "not_now", since: reply.at };
  }

  const waits: Array<Date | null> = [];
  for (const message of facts.openMessages) {
    if (message.status !== "pending_review") continue;
    waits.push(facts.approvals.get(message.id)?.created_at ?? message.created_at);
  }
  waits.push(...facts.otherApprovals.map((row) => row.created_at));
  for (const row of facts.enrollments) {
    if (row.enrollment.status === "paused" || row.enrollment.status === "waiting_review") {
      waits.push(row.enrollment.updated_at);
    }
  }
  if (company?.hold_until && company.hold_until > now) waits.push(company.updated_at);
  if (waits.length > 0) return { state: "waiting", since: earliest(waits) };

  const running = facts.enrollments.filter((row) =>
    ["queued", "active"].includes(row.enrollment.status),
  );
  if (running.length > 0) {
    return {
      state: "in_sequence",
      since: earliest(
        running.map((row) => row.enrollment.activated_at ?? row.enrollment.enrolled_at),
      ),
    };
  }

  const lost = facts.opportunities.find((row) => row.stage === "lost");
  if (lost) return { state: "lost", since: lost.closed_at ?? lost.updated_at };
  if (person.status === "not_interested") return { state: "lost", since: person.updated_at };

  const ended = facts.enrollments.filter((row) =>
    ["completed", "stopped", "failed"].includes(row.enrollment.status),
  );
  if (ended.length > 0) {
    return { state: "finished", since: latest(ended.map((row) => row.enrollment.completed_at)) };
  }
  if (person.last_contacted_at) return { state: "finished", since: person.last_contacted_at };
  return { state: "new", since: person.created_at };
}

/** The open opportunity (else the most recent one). */
function currentOpportunity(facts: RelationshipFacts) {
  return (
    facts.opportunities.find(
      (row) => row.stage === "interested" || row.stage === "meeting_booked",
    ) ??
    facts.opportunities[0] ??
    null
  );
}

/** What the view asks the eligibility checks: the next action's channel, message and step. */
function eligibilityInput(
  facts: RelationshipFacts,
  next: NextAction | null,
  now: Date,
): EligibilityInput {
  const personId = facts.person.id;
  const due = next?.due_at ? new Date(next.due_at) : null;
  const at = due && due > now ? due : undefined;
  if (next?.channel && next.ref?.type === "message") {
    return { personId, channel: next.channel, messageId: next.ref.id, ...(at ? { at } : {}) };
  }
  if (next?.channel && next.ref?.type === "approval") {
    const message = facts.openMessages.find(
      (row) => facts.approvals.get(row.id)?.id === next.ref?.id,
    );
    if (message) return { personId, channel: next.channel, messageId: message.id };
  }
  if (next?.kind === "campaign_step" && next.channel && next.ref) {
    const row = facts.enrollments.find((item) => item.enrollment.id === next.ref?.id);
    const input: EligibilityInput = {
      personId,
      channel: next.channel,
      campaignId: next.campaign_id,
      messageId: null,
      ...(at ? { at } : {}),
    };
    if (row?.step) input.action = stepAction(row.step.type);
    return input;
  }
  // Nothing queued: could we talk to them? In a conversation, that means answering it.
  const talking = facts.threads.find((row) => row.latest_direction === "inbound");
  if (talking) {
    return {
      personId,
      channel: talking.channel,
      threadId: talking.id,
      action: talking.channel === "email" ? "reply" : "message",
      messageId: null,
    };
  }
  return { personId, channel: next?.channel ?? "email", messageId: null };
}

/** Blockers that hold the whole relationship, whatever the channel. */
function relationshipBlockers(facts: RelationshipFacts, now: Date, zone: string): Blocker[] {
  const base = {
    now,
    zone,
    person: personName(facts.person),
    personId: facts.person.id,
    company: facts.company?.name ?? null,
    companyId: facts.company?.id ?? null,
  };
  const out: Blocker[] = [];
  const privacy = facts.privacy[0];
  if (privacy) out.push(blocker("privacy_request_open", { ...base, problemId: privacy.id }));
  const hold = facts.company?.hold_until;
  if (hold && hold > now) {
    out.push(
      blocker("company_on_hold", {
        ...base,
        endsAt: hold,
        until: hold,
        detail: facts.company?.hold_reason ?? null,
      }),
    );
  }
  return out;
}

/**
 * Someone who made a privacy request keeps every suppression, so no blocker suggests lifting
 * one for them (the fix is dropped; the message still says why nothing goes out).
 */
function keepPrivacySuppressions(blockers: Blocker[], facts: RelationshipFacts): Blocker[] {
  if (!facts.askedForPrivacy) return blockers;
  return blockers.map((item) =>
    item.code.startsWith("suppressed_") && item.fix ? { ...item, fix: null } : item,
  );
}

/**
 * The relationship view of one person. Throws `not_found` for a person outside the workspace
 * (deleted or forgotten people have no relationship).
 */
export async function getRelationship(ctx: OpContext, personId: string): Promise<RelationshipView> {
  const loader = await EligibilityLoader.create(ctx);
  const person = await loader.person(personId);
  if (!person) {
    throw new OpenOutboundError("not_found", `Person ${personId} not found.`, {
      hint: "Use a person id starting with pe_ (get_lead or manage_leads list them); deleted or forgotten people have no relationship.",
      details: { what: "Person", id: personId },
    });
  }
  const company = await loader.company(person.company_id);
  const facts = await loadRelationshipFacts(loader.ctx, person, company);
  const now = loader.now;
  const zone = isValidTimeZone(loader.workspace.timezone) ? loader.workspace.timezone : "UTC";
  const decided = decideState(facts, now, loader.settings);
  const next = pickNextAction(facts, now, zone);
  const [eligibility] = await checkEligibilityMany(
    loader.ctx,
    [eligibilityInput(facts, next, now)],
    { loader },
  );
  const stuck = await stuckForPerson(loader.ctx, person.id);
  // The next action's own time, as get_next_actions lists it: a message's slot (or its
  // sequence's next run), else the due time.
  const message =
    next?.ref?.type === "message"
      ? facts.openMessages.find((row) => row.id === next.ref?.id)
      : undefined;
  const run = facts.enrollments.find(
    (row) => message?.enrollment_id && row.enrollment.id === message.enrollment_id,
  )?.enrollment;
  const planned = message
    ? (message.scheduled_for ?? run?.paused_until ?? run?.next_run_at ?? null)
    : next?.due_at
      ? new Date(next.due_at)
      : null;
  return {
    person_id: person.id,
    company_id: person.company_id,
    opportunity_id: currentOpportunity(facts)?.id ?? null,
    state: decided.state,
    state_since: decided.since?.toISOString() ?? null,
    next_action: next,
    blockers: keepPrivacySuppressions(
      uniqueBlockers([
        ...withoutTimingWaits(eligibility?.blockers ?? [], planned),
        ...relationshipBlockers(facts, now, zone),
      ]),
      facts,
    ),
    stuck: stuck.length > 0,
    stuck_reason: stuck[0]?.reason ?? null,
  };
}
