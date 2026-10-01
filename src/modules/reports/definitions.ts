/**
 * Metric catalog: labels and units for rendering, and the definitions every report returns
 * once in its `definitions` field (so agents and humans read numbers the same way).
 */
export type MetricUnit = "count" | "percent" | "usd" | "credits" | "ratio";

export interface MetricInfo {
  label: string;
  unit: MetricUnit;
  definition: string;
}

export const METRICS = {
  new_leads: {
    label: "New leads",
    unit: "count",
    definition: "People added to the workspace in the period.",
  },
  enrolled: {
    label: "Enrolled",
    unit: "count",
    definition: "Enrollments created in the period (people added to a campaign).",
  },
  contacted: {
    label: "Contacted",
    unit: "count",
    definition:
      "Distinct people sent at least one email, LinkedIn invite or LinkedIn message in the period.",
  },
  emails_sent: {
    label: "Emails sent",
    unit: "count",
    definition: "Outbound emails sent in the period, including ones that bounced.",
  },
  linkedin_sent: {
    label: "LinkedIn sent",
    unit: "count",
    definition: "LinkedIn invites, messages and comments sent in the period.",
  },
  replies: {
    label: "Replied",
    unit: "count",
    definition:
      "Distinct people who replied in the period. Out-of-office and other auto-replies and bounces are not replies.",
  },
  positive_replies: {
    label: "Positive",
    unit: "count",
    definition:
      "Distinct people with a reply classified interested or meeting_request in the period.",
  },
  meetings: {
    label: "Meetings",
    unit: "count",
    definition:
      "Meetings booked in the period: meeting records by the time they were booked or recorded, whatever happened to them later, plus opportunities that reached meeting_booked without a meeting record (from opportunity.updated events, else the creation time of opportunities created with a meeting).",
  },
  meetings_held: {
    label: "Meetings held",
    unit: "count",
    definition:
      "Meetings due in the period (by start time) that were held: marked held, or counted as held booking.assume_held_after_hours after their start without a cancellation or no-show.",
  },
  no_shows: {
    label: "No-shows",
    unit: "count",
    definition: "Meetings due in the period (by start time) that the lead did not attend.",
  },
  meetings_cancelled: {
    label: "Meetings cancelled",
    unit: "count",
    definition: "Meetings due in the period (by start time) that were cancelled.",
  },
  held_rate: {
    label: "Held rate",
    unit: "percent",
    definition:
      "Held rate = held meetings / (held meetings + no-shows) x 100, for meetings due in the period.",
  },
  qualified_meetings: {
    label: "Qualified meetings",
    unit: "count",
    definition:
      "Held meetings due in the period that were marked qualified (they met the client's definition in strategy.qualified_meeting).",
  },
  bounced: {
    label: "Bounced",
    unit: "count",
    definition: "Emails sent in the period that hard-bounced.",
  },
  reply_rate: {
    label: "Reply rate",
    unit: "percent",
    definition: "Reply rate = replied people / contacted people x 100.",
  },
  positive_rate: {
    label: "Positive rate",
    unit: "percent",
    definition:
      "Positive rate = people with an interested or meeting_request reply / contacted people x 100.",
  },
  bounce_rate: {
    label: "Bounce rate",
    unit: "percent",
    definition: "Bounce rate = bounced emails / sent emails x 100.",
  },
  meeting_rate: {
    label: "Meeting rate",
    unit: "percent",
    definition: "Meeting rate = meetings / people reached x 100.",
  },
  sent: {
    label: "Sent",
    unit: "count",
    definition:
      "Messages sent by the step in the period (emails, invites, messages, comments, likes, visits).",
  },
  people: {
    label: "People",
    unit: "count",
    definition: "Distinct people the row reached in the period.",
  },
  accepted: {
    label: "Accepted",
    unit: "count",
    definition: "LinkedIn invites sent in the period whose relation is now connected.",
  },
  duplicates: {
    label: "Went out twice",
    unit: "count",
    definition:
      "Messages found in the period to have gone out twice (event message.duplicate: an earlier try's answer came late, after the engine had sent the message again), each counted once. Each has a duplicate_send problem.",
  },
  detected: {
    label: "Detected",
    unit: "count",
    definition: "Signals detected in the period.",
  },
  messages: {
    label: "Messages",
    unit: "count",
    definition:
      "Messages sent in the period whose writing used the signal (why.signal_keys or why.signal_ids).",
  },
  lift: {
    label: "Lift",
    unit: "ratio",
    definition:
      "Lift = positive rate of people reached with the signal / positive rate of people contacted without any signal.",
  },
  suggested_weight: {
    label: "Suggested weight",
    unit: "count",
    definition:
      "Signal weight suggested from the data (playbook formula, smoothed toward the current weight with 100 pseudo-sends, at most 15 points from it). Null until both the signal and the no-signal baseline have 150+ people and 5+ positive replies.",
  },
  new_opportunities: {
    label: "New opportunities",
    unit: "count",
    definition: "Opportunities created in the period.",
  },
  won: {
    label: "Won",
    unit: "count",
    definition: "Opportunities closed as won in the period.",
  },
  lost: {
    label: "Lost",
    unit: "count",
    definition: "Opportunities closed as lost in the period.",
  },
  win_rate: {
    label: "Win rate",
    unit: "percent",
    definition: "Win rate = won / (won + lost) x 100, for opportunities closed in the period.",
  },
  ai_cost_usd: {
    label: "AI cost",
    unit: "usd",
    definition: "Sum of cost_usd of brain usage records in the period.",
  },
  data_cost_usd: {
    label: "Data cost",
    unit: "usd",
    definition:
      "Sum of cost_usd reported by data providers (lead sources, finders, verifiers, research, signals) in the period.",
  },
  data_credits: {
    label: "Data credits",
    unit: "credits",
    definition: "Sum of provider credits used by data providers in the period.",
  },
  total_cost_usd: {
    label: "Total cost",
    unit: "usd",
    definition: "AI cost + data cost.",
  },
  pending_approvals: {
    label: "Pending approvals",
    unit: "count",
    definition: "Approvals waiting for a decision right now.",
  },
} as const satisfies Record<string, MetricInfo>;

export type MetricKey = keyof typeof METRICS;

/** General rules that apply to every report. */
export const GENERAL_DEFINITIONS: Record<string, string> = {
  counting:
    "Counts are activity inside the period: a reply counts in the period it arrived, even when the first touch was earlier.",
  rates:
    "Rates are percentages (0-100) with one decimal and null when the denominator is 0. change is value - previous (percentage points for rates); change_pct is the relative change and null when previous is 0.",
  period:
    "Periods are half-open [from, to) in the report timezone. Presets ending today (today, this_month, this_quarter) compare with the same elapsed part of the previous day, month or quarter.",
};

/** The `definitions` output: general rules plus the given metrics, each documented once. */
export function definitionsFor(keys: readonly MetricKey[]): Record<string, string> {
  const out: Record<string, string> = { ...GENERAL_DEFINITIONS };
  for (const key of keys) out[key] = METRICS[key].definition;
  return out;
}
