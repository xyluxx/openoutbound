/**
 * Checks shared by both channels: the message itself, the workspace, the person, the campaign
 * and enrollment, thread ownership, contactability with an open privacy request, the enrollment
 * rules for new outreach and the AI budget. Channel checks live in checks-email.ts and
 * checks-linkedin.ts; gate.ts runs them in the senders' order.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Company, Enrollment } from "../../db/schema/index.js";
import { enrollments, people } from "../../db/schema/index.js";
import { IN_PROGRESS, PENDING_CLASSIFICATION } from "../campaigns/control.js";
import { stepUsesAi } from "../campaigns/steps.js";
import { isValidTimeZone, localDate, startOfNextDay } from "../email/timezone.js";
import { SUPERSEDED_BY_PERSON } from "../inbox/stale-replies.js";
import { type Blocker, blocker } from "./blockers.js";
import type {
  CheckResult,
  CheckState,
  EligibilityCheck,
  GateBlocker,
  GateDisposition,
} from "./eligibility-types.js";

const DAY_MS = 86_400_000;
/** A message waiting for a company hold looks again at least this often (a changed hold). */
const HOLD_RECHECK_MS = DAY_MS;
/** A sequence step waiting for a paused sequence with no end date looks again this often. */
const PAUSED_STEP_RECHECK_MS = 60 * 60_000;

/** Code of an open privacy request (it blocks every channel, answers included). */
export const PRIVACY_REQUEST_OPEN = "privacy_request_open";

/** The key that wakes send jobs waiting for a company hold (`company.hold_changed` wakes it). */
export function companyHoldKey(companyId: string): string {
  return `company_hold:${companyId}`;
}

/** The key that wakes send jobs waiting for a paused workspace. */
export function workspaceActiveKey(workspaceId: string): string {
  return `workspace_active:${workspaceId}`;
}

/** The key that wakes send jobs waiting for a paused campaign. */
export function campaignActiveKey(campaignId: string): string {
  return `campaign_active:${campaignId}`;
}

/** What the sender does about a blocker, with its details (see `GateDisposition`). */
export function gated(
  item: Blocker,
  disposition: GateDisposition,
  extra: Pick<GateBlocker, "wait_key" | "detail" | "retry_at" | "keep_sender"> = {},
): GateBlocker {
  return { ...item, disposition, ...extra };
}

/** A blocker only the views show (a message that is not due, a new message): nothing to do yet. */
export function waiting(item: Blocker): GateBlocker {
  return gated(item, "wait");
}

export function one(item: GateBlocker, stop = false): CheckResult {
  return { blockers: [item], stop };
}

/** The workspace's zone (daily counters and budgets reset in it). */
export function workspaceZone(state: CheckState): string {
  const zone = state.loader.workspace.timezone;
  return isValidTimeZone(zone) ? zone : "UTC";
}

/** The message in question: its status decides whether anything else matters. */
export const messageState: EligibilityCheck = {
  name: "message_state",
  async run(state) {
    const { message, facts } = state;
    if (state.input.messageId && !message) {
      return one(waiting(blocker("message_not_found", facts)), true);
    }
    if (!message) return null;
    if (message.direction !== "outbound") {
      return one(waiting(blocker("message_not_found", facts)), true);
    }
    const error = message.error?.trim() || null;
    switch (message.status) {
      case "scheduled":
      case "approved":
        return null;
      case "pending_review":
        return one(
          waiting(
            blocker("approval_pending", {
              ...facts,
              approvalId: state.approval?.id ?? null,
              since: state.approval?.created_at ?? message.created_at,
            }),
          ),
        );
      case "draft":
        // A step's draft is the sequencer's to review or schedule; a reply draft waits for a send.
        return one(
          waiting(
            blocker(
              "message_draft",
              { ...facts, stepId: message.step_id },
              message.step_id ? { hard: false } : {},
            ),
          ),
        );
      case "generating":
        return one(waiting(blocker("message_generating", facts)));
      case "sending":
        return one(waiting(blocker("message_sending", facts)), true);
      case "unknown":
        return one(waiting(blocker("send_unknown", facts)), true);
      case "sent":
        return one(waiting(blocker("message_sent", { ...facts, since: message.sent_at })), true);
      case "failed":
      case "skipped":
      case "bounced":
      case "cancelled":
        return one(
          waiting(blocker(`message_${message.status}`, { ...facts, detail: error })),
          true,
        );
      default:
        return one(waiting(blocker("message_not_found", facts)), true);
    }
  },
};

/**
 * The kill switch: a paused workspace sends nothing and the sender waits for the resume. An
 * archived one waits too for email; LinkedIn actions go back to the queue.
 */
export const workspaceActive: EligibilityCheck = {
  name: "workspace",
  async run(state) {
    const workspace = state.loader.workspace;
    if (workspace.status === "active") return null;
    const item = blocker(
      workspace.status === "paused" ? "workspace_paused" : "workspace_archived",
      state.facts,
    );
    if (state.channel === "linkedin" && workspace.status !== "paused") {
      return one(gated(item, "move", { detail: `workspace ${workspace.status}` }));
    }
    return one(gated(item, "wait", { wait_key: workspaceActiveKey(workspace.id) }));
  },
};

/** The person must exist: an email to someone deleted or forgotten is cancelled. */
export const personExists: EligibilityCheck = {
  name: "person",
  async run(state) {
    const { message } = state;
    // The email sender only needs a person when the message names one.
    if (message && !message.person_id) return null;
    if (state.person) return null;
    const item = blocker("person_not_found", state.facts);
    return one(
      message
        ? gated(item, "cancel", { detail: "The person no longer exists (deleted or forgotten)." })
        : waiting(item),
      true,
    );
  },
};

/**
 * A paused campaign holds its queued messages (answers to prospects still go); a sequence step
 * of a campaign that was stopped or archived never goes out.
 */
export const campaignActive: EligibilityCheck = {
  name: "campaign",
  async run(state) {
    const { campaign, message, facts } = state;
    if (!campaign) return null;
    if (message) {
      if (message.step_id && (campaign.status === "completed" || campaign.status === "archived")) {
        const item = blocker("campaign_inactive", { ...facts, status: campaign.status });
        return one(gated(item, "cancel", { detail: `campaign_${campaign.status}` }), true);
      }
      return campaign.status === "paused" && message.action !== "reply"
        ? one(
            gated(blocker("campaign_paused", facts), "wait", {
              wait_key: campaignActiveKey(campaign.id),
            }),
          )
        : null;
    }
    if (state.answering) return null;
    if (campaign.status === "paused") return one(waiting(blocker("campaign_paused", facts)));
    if (campaign.status !== "active") {
      return one(waiting(blocker("campaign_inactive", { ...facts, status: campaign.status })));
    }
    return null;
  },
};

function pauseWords(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === PENDING_CLASSIFICATION) return "a reply waits for classification";
  if (reason === "out_of_office") return "out of office";
  return reason.replace(/_/g, " ");
}

/** The paused sequence in words, with the time it resumes when it has one. */
function pausedBlocker(state: CheckState, enrollment: Enrollment): Blocker {
  const until =
    enrollment.paused_until && enrollment.paused_until > state.at ? enrollment.paused_until : null;
  return blocker("enrollment_paused", {
    ...state.facts,
    detail: pauseWords(enrollment.stop_reason),
    status: enrollment.stop_reason,
    until,
    zone: state.facts.zone,
  });
}

/**
 * A sequence step follows its sequence (a resend after an unknown outcome is scheduled again
 * whatever the sequence did meanwhile): one whose sequence ended is cancelled, one whose
 * sequence is paused waits until it resumes (looked at again hourly without an end date).
 */
function stepOfSequence(state: CheckState, enrollment: Enrollment): CheckResult | null {
  switch (enrollment.status) {
    case "completed":
    case "stopped":
    case "failed": {
      const item = blocker("enrollment_ended", { ...state.facts, status: enrollment.status });
      const reason = enrollment.stop_reason ?? enrollment.status;
      return one(gated(item, "cancel", { detail: `enrollment_stopped:${reason}` }), true);
    }
    case "paused": {
      const item = pausedBlocker(state, enrollment);
      const recheck = new Date(state.now.getTime() + PAUSED_STEP_RECHECK_MS).toISOString();
      return one(gated(item, "wait", { retry_at: item.until ?? recheck }));
    }
    default:
      return null;
  }
}

/**
 * The person's enrollment in the campaign: paused, waiting for a review, or ended. The sender
 * looks at the enrollment of a sequence step only (see `stepOfSequence`); other scheduled
 * messages go out whatever their enrollment says, so only messages that still wait to be
 * scheduled and new steps are held here.
 */
export const enrollmentState: EligibilityCheck = {
  name: "enrollment",
  async run(state) {
    const { enrollment, message, facts } = state;
    if (!enrollment) return null;
    if (message?.step_id) {
      const step = stepOfSequence(state, enrollment);
      if (step) return step;
    }
    if (message?.status === "scheduled") return null;
    switch (enrollment.status) {
      case "paused":
        return one(waiting(pausedBlocker(state, enrollment)));
      case "waiting_review":
        return message?.status === "pending_review"
          ? null
          : one(waiting(blocker("enrollment_waiting_review", facts)));
      case "completed":
      case "stopped":
      case "failed":
        return message
          ? null
          : one(waiting(blocker("enrollment_ended", { ...facts, status: enrollment.status })));
      default:
        return null;
    }
  },
};

/**
 * A thread a person took over: the engine sends no automatic replies or sequence steps in it
 * (the sender cancels them with `superseded_by_person`, like the takeover does). Replies a
 * person or an agent wrote or approved still go.
 */
export const threadOwner: EligibilityCheck = {
  name: "thread_owner",
  async run(state) {
    if (state.thread?.owner !== "person" || !state.automatic) return null;
    const item = blocker("thread_owned_by_person", { ...state.facts, threadId: state.thread.id });
    return one(
      state.message ? gated(item, "cancel", { detail: SUPERSEDED_BY_PERSON }) : waiting(item),
    );
  },
};

/**
 * New outreach in a campaign the person is not in yet: the enrollment rules (one active
 * campaign per person, rest days after a campaign, the per-company cap).
 */
export const outreachRules: EligibilityCheck = {
  name: "outreach_rules",
  async run(state) {
    const { person, campaign, message, facts, loader } = state;
    if (message || state.answering || !person || !campaign) return null;
    if (state.enrollment) return null;
    const compliance = loader.settings.compliance;
    const found: GateBlocker[] = [];
    const mine = await loader.personEnrollments(person.id);
    if (compliance.one_active_campaign_per_person) {
      const other = mine.find(
        (row) => row.campaign_id !== campaign.id && IN_PROGRESS.includes(row.status),
      );
      if (other) {
        const otherCampaign = await loader.campaign(other.campaign_id);
        found.push(
          waiting(
            blocker("active_in_other_campaign", {
              ...facts,
              otherCampaign: otherCampaign?.campaign.name ?? null,
            }),
          ),
        );
      }
    }
    if (compliance.rest_days_after_campaign > 0) {
      const restMs = compliance.rest_days_after_campaign * DAY_MS;
      const ends = mine
        .filter(
          (row) => ["completed", "stopped", "failed"].includes(row.status) && row.completed_at,
        )
        .map((row) => (row.completed_at as Date).getTime() + restMs)
        .filter((end) => end > state.at.getTime());
      if (ends.length > 0) {
        found.push(
          waiting(blocker("rest_period", { ...facts, until: new Date(Math.max(...ends)) })),
        );
      }
    }
    if (person.company_id) {
      const [row] = await loader.ctx.db
        .select({ id: enrollments.id })
        .from(enrollments)
        .innerJoin(people, eq(people.id, enrollments.person_id))
        .where(
          and(
            eq(enrollments.workspace_id, loader.workspace.id),
            eq(people.company_id, person.company_id),
            inArray(enrollments.status, IN_PROGRESS),
          ),
        )
        .orderBy(desc(enrollments.enrolled_at))
        .offset(Math.max(0, compliance.contact_cap_per_company - 1))
        .limit(1);
      if (row) {
        found.push(
          waiting(
            blocker("company_cap_reached", {
              ...facts,
              limit: compliance.contact_cap_per_company,
              count: compliance.contact_cap_per_company,
            }),
          ),
        );
      }
    }
    return found.length > 0 ? { blockers: found } : null;
  },
};

/** A sequence step that still has to be written needs AI budget. */
export const aiBudget: EligibilityCheck = {
  name: "ai_budget",
  async run(state) {
    const { enrollment, message, loader } = state;
    if (message || !enrollment || !["active", "queued"].includes(enrollment.status)) return null;
    const step = await loader.stepAt(enrollment.campaign_id, enrollment.current_step);
    if (!step || !stepUsesAi(step)) return null;
    const status = await loader.budget("ai");
    if (status.budget === null || (status.remaining ?? 1) > 0) return null;
    const zone = workspaceZone(state);
    const month = localDate(state.now, zone).slice(0, 7);
    const lastDay = new Date(`${month}-01T12:00:00Z`);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
    lastDay.setUTCDate(0);
    const until = startOfNextDay(lastDay.toISOString().slice(0, 10), zone);
    return one(waiting(blocker("ai_budget_used_up", { ...state.facts, until, zone })));
  },
};

/** The company contactability reads: the person's own, else the message's. */
async function contactCompany(state: CheckState): Promise<Company | null> {
  const companyId = state.person?.company_id;
  if (!companyId || companyId === state.company?.id) return state.company;
  return (await state.loader.company(companyId)) ?? state.company;
}

/** A contactability code in words (holds, owners and privacy requests add their details). */
export function contactBlocker(
  state: CheckState,
  code: string,
  extra: { company?: Company | null; holdWaits?: boolean; problemId?: string | null } = {},
): Blocker {
  const { facts } = state;
  const company = extra.company ?? state.company;
  const zone = workspaceZone(state);
  if (code === "company_on_hold" && company) {
    const endsAt = company.hold_until;
    // A queued message waits for the hold to end unless something else skips it for good.
    const until = !state.message || extra.holdWaits ? endsAt : null;
    return blocker("company_on_hold", {
      ...facts,
      company: company.name,
      companyId: company.id,
      endsAt,
      until,
      zone,
      detail: company.hold_reason,
    });
  }
  if (code === "company_owned" && company) {
    return blocker("company_owned", { ...facts, detail: company.crm_owner });
  }
  if (code === PRIVACY_REQUEST_OPEN) {
    return blocker(code, { ...facts, problemId: extra.problemId ?? null });
  }
  return blocker(code, facts);
}

/**
 * Contactability codes and an open privacy request, decided together as the senders do. An
 * open privacy request is added to the codes (it stops answers too). A company hold alone makes
 * a queued message wait until the hold ends (`company.hold_changed` wakes it early, and it looks
 * again at least daily); anything else skips it, with `stored` as the reason the sender records.
 */
export async function contactGroup(
  state: CheckState,
  codes: readonly string[],
  stored: (codes: readonly string[]) => string,
): Promise<CheckResult | null> {
  const privacy = state.person ? await state.loader.privacyRequest(state.person.id) : null;
  const all = [...new Set([...codes, ...(privacy ? [PRIVACY_REQUEST_OPEN] : [])])];
  if (all.length === 0) return null;
  const company = await contactCompany(state);
  const now = state.now.getTime();
  const holdEnd = company?.hold_until?.getTime() ?? 0;
  const holdWaits = all.length === 1 && all[0] === "company_on_hold" && holdEnd > now;
  const extra =
    holdWaits && company
      ? {
          wait_key: companyHoldKey(company.id),
          retry_at: new Date(Math.min(holdEnd, now + HOLD_RECHECK_MS)).toISOString(),
        }
      : { detail: stored(all) };
  const disposition: GateDisposition = !state.message || holdWaits ? "wait" : "skip";
  const blockers = all
    .filter((code) => !state.codes.has(code))
    .map((code) =>
      gated(
        contactBlocker(state, code, { company, holdWaits, problemId: privacy?.id ?? null }),
        disposition,
        extra,
      ),
    );
  return blockers.length > 0 ? { blockers } : null;
}
