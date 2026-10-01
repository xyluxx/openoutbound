/**
 * Scenario 6: weekly report. A known week of activity (and a quieter week before it) is in
 * the database; the agent must pull the numbers from the engine and write a short markdown
 * summary with the right figures, without changing anything.
 */
import type { NewMessage, NewOpportunity } from "../../src/db/schema/index.js";
import { messages, opportunities } from "../../src/db/schema/index.js";
import {
  callsOf,
  describeCalls,
  looksLikeMarkdown,
  mentionsAny,
  mentionsNumber,
  mentionsPercent,
  outcome,
  writeCalls,
} from "../harness/checks.js";
import { check, defineScenario } from "../harness/types.js";
import { clearActivity, contactablePeople } from "./support.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The week the report covers. */
export const THIS_WEEK = {
  contacted: 20,
  emails_sent: 24,
  bounced: 2,
  replies: 5,
  positive_replies: 3,
  meetings: 1,
  reply_rate: 25,
  positive_rate: 15,
  bounce_rate: 8.3,
};

/** The week before (for the comparison). */
export const LAST_WEEK = { contacted: 10, emails_sent: 10, replies: 2, positive_replies: 1 };

const REPLIES: Array<{ category: string; text: string }> = [
  { category: "interested", text: "This is timely, tell me more about how the forecast works." },
  { category: "interested", text: "Sounds interesting. What does onboarding look like?" },
  { category: "meeting_request", text: "Happy to talk. Does Thursday afternoon work for a call?" },
  { category: "not_now", text: "Not now, we are mid-migration. Try me next quarter." },
  { category: "question", text: "Do you support multiple warehouses?" },
];

interface WeeklyData {
  period_from: string;
  period_to: string;
}

export const weeklyReport = defineScenario<WeeklyData>({
  id: "weekly-report",
  title: "Weekly report with correct numbers",
  prompt:
    "Write this week's performance report for the Northwind client, covering the last 7 full days. Include emails sent, people contacted, replies and the reply rate, positive replies, meetings booked and bounces, each compared with the week before, and end with one line on what to focus on next week. Reply with the report as a short markdown summary I can paste into Slack. This is a read-only task: do not change anything.",
  toolsets: "core",
  maxTurns: 12,
  rubric: [
    "Pulls the numbers from get_report (overview, last_7_days) instead of estimating them.",
    "Every figure in the summary matches the engine's report, including rates and the week-over-week change.",
    "Short, scannable markdown; one concrete next step grounded in the numbers.",
    "Makes no changes (read-only tools only).",
  ],
  async setup(api) {
    const { workspaces } = await api.seedSandbox();
    const workspaceId = workspaces.northwind as string;
    await clearActivity(api.db, workspaceId);
    const report = await api.call<{ period: { from: string; to: string } }>(
      "reports.get",
      { type: "overview", period: "last_7_days", format: "json", compare: false },
      { workspace: workspaceId },
    );
    const from = new Date(report.period.from).getTime();
    const previousFrom = from - 7 * DAY;
    const pool = await contactablePeople(
      api.db,
      workspaceId,
      THIS_WEEK.contacted + LAST_WEEK.contacted,
    );
    if (pool.length < THIS_WEEK.contacted + LAST_WEEK.contacted) {
      throw new Error(`weekly-report setup: only ${pool.length} contactable people in the sandbox`);
    }
    const thisWeek = pool.slice(0, THIS_WEEK.contacted);
    const lastWeek = pool.slice(THIS_WEEK.contacted);
    const rows: NewMessage[] = [];
    const sent = (personId: string, companyId: string | null, at: number, bounced = false) =>
      rows.push({
        workspace_id: workspaceId,
        person_id: personId,
        company_id: companyId,
        channel: "email",
        action: "email",
        direction: "outbound",
        status: bounced ? "bounced" : "sent",
        subject: "reorder timing",
        body_text: "Hi, a short note about reorder timing.",
        sent_at: new Date(at),
      });
    const reply = (personId: string, companyId: string | null, at: number, index: number) => {
      const spec = REPLIES[index % REPLIES.length] as (typeof REPLIES)[number];
      rows.push({
        workspace_id: workspaceId,
        person_id: personId,
        company_id: companyId,
        channel: "email",
        action: "reply",
        direction: "inbound",
        status: "received",
        subject: "Re: reorder timing",
        body_text: spec.text,
        received_at: new Date(at),
        classification: {
          category: spec.category as never,
          confidence: 0.9,
          source: "model",
          classified_at: new Date(at + HOUR).toISOString(),
        },
      });
    };

    // This week: 20 first emails (2 bounced) and 4 follow-ups, 5 replies, 1 meeting.
    thisWeek.forEach((person, index) => {
      sent(person.id, person.company_id, from + DAY + index * HOUR, index >= 18);
    });
    thisWeek.slice(5, 9).forEach((person, index) => {
      sent(person.id, person.company_id, from + 4 * DAY + index * HOUR);
    });
    thisWeek.slice(0, 5).forEach((person, index) => {
      reply(person.id, person.company_id, from + 2 * DAY + index * HOUR, index);
    });
    // The week before: 10 first emails, 2 replies (one positive).
    lastWeek.forEach((person, index) => {
      sent(person.id, person.company_id, previousFrom + DAY + index * HOUR);
    });
    lastWeek.slice(0, 2).forEach((person, index) => {
      reply(person.id, person.company_id, previousFrom + 3 * DAY + index * HOUR, index * 3);
    });
    await api.db.insert(messages).values(rows);

    const booked = thisWeek[2];
    const meeting: NewOpportunity = {
      workspace_id: workspaceId,
      person_id: booked?.id ?? null,
      company_id: booked?.company_id ?? null,
      stage: "meeting_booked",
      meeting_at: new Date(from + 6 * DAY),
      created_at: new Date(from + 3 * DAY),
      updated_at: new Date(from + 3 * DAY),
    };
    await api.db.insert(opportunities).values(meeting);
    return {
      workspace: workspaceId,
      data: { period_from: report.period.from, period_to: report.period.to },
    };
  },
  async script(agent) {
    const report = await agent.ok("get_report", {
      type: "overview",
      period: "last_7_days",
      format: "json",
      reason: "Weekly client report",
    });
    const m = report.data.metrics as Record<
      string,
      { value: number | null; previous: number | null; change_pct: number | null }
    >;
    const line = (label: string, key: string, unit = "") => {
      const metric = m[key];
      const value = metric?.value ?? 0;
      const previous = metric?.previous ?? 0;
      return `- ${label}: ${value}${unit} (previous week ${previous}${unit})`;
    };
    return [
      `## Northwind weekly report (${report.period.start_date} to ${report.period.end_date})`,
      line("Emails sent", "emails_sent"),
      line("People contacted", "contacted"),
      line("Replies", "replies"),
      line("Reply rate", "reply_rate", "%"),
      line("Positive replies", "positive_replies"),
      line("Meetings booked", "meetings"),
      line("Bounces", "bounced"),
      "",
      "Next week: follow up on the open positive replies and check the two bounced addresses before the next send.",
    ].join("\n");
  },
  assertions: [
    check("used get_report for the last 7 days", ({ calls }) => {
      const reports = callsOf(
        calls,
        "reports.get",
        (call) =>
          call.outcome === "ok" &&
          (call.input.type ?? "overview") === "overview" &&
          (call.input.period ?? "last_7_days") === "last_7_days",
      );
      return outcome(
        reports.length > 0,
        `report calls: ${describeCalls(callsOf(calls, "reports.get"))}`,
      );
    }),
    check("engine report matches the seeded week", async ({ call }) => {
      const report = await call<{
        data: { metrics: Record<string, { value: number | null; previous: number | null }> };
      }>("reports.get", { type: "overview", period: "last_7_days", format: "json" });
      const m = report.data.metrics;
      const expected: Record<string, number> = { ...THIS_WEEK };
      const wrong = Object.entries(expected)
        .filter(([key, value]) => m[key]?.value !== value)
        .map(([key, value]) => `${key}=${m[key]?.value} (expected ${value})`);
      const previousWrong = Object.entries(LAST_WEEK)
        .filter(([key, value]) => m[key]?.previous !== value)
        .map(([key, value]) => `previous ${key}=${m[key]?.previous} (expected ${value})`);
      const problems = [...wrong, ...previousWrong];
      return outcome(problems.length === 0, problems.join("; "));
    }),
    check("reports emails sent and people contacted", ({ finalText }) =>
      outcome(
        mentionsNumber(finalText, THIS_WEEK.emails_sent) &&
          mentionsNumber(finalText, THIS_WEEK.contacted),
        "expected 24 emails sent and 20 contacted in the summary",
      ),
    ),
    check("reports replies with the reply rate", ({ finalText }) =>
      outcome(
        mentionsNumber(finalText, THIS_WEEK.replies) &&
          mentionsPercent(finalText, THIS_WEEK.reply_rate),
        "expected 5 replies and a 25% reply rate",
      ),
    ),
    check("reports positive replies, meetings and bounces", ({ finalText }) =>
      outcome(
        mentionsNumber(finalText, THIS_WEEK.positive_replies) &&
          mentionsNumber(finalText, THIS_WEEK.meetings) &&
          mentionsNumber(finalText, THIS_WEEK.bounced) &&
          mentionsAny(finalText, ["meeting"]) &&
          mentionsAny(finalText, ["bounce"]),
        "expected 3 positive replies, 1 meeting and 2 bounces",
      ),
    ),
    check("compares with the week before", ({ finalText }) =>
      outcome(
        mentionsNumber(finalText, LAST_WEEK.emails_sent) ||
          mentionsAny(finalText, ["+14", /\b140(\.0)?\s?%/]),
        "expected the previous week's 10 emails or the +14 / +140% change",
      ),
    ),
    check("answer is markdown", ({ finalText }) =>
      outcome(looksLikeMarkdown(finalText), "no heading, table or list found"),
    ),
    check("read-only session", ({ engine, calls }) => {
      const writes = writeCalls(engine, calls);
      return outcome(writes.length === 0, `changed state: ${describeCalls(writes)}`);
    }),
  ],
});
