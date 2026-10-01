/**
 * Scenario: book after a proposed time. Northwind lets a person book every meeting (booking mode
 * handoff). A prospect answered the first email with a time ("Tuesday at 3pm works for a quick
 * call"); the engine drafted nothing and opened a meeting_to_book problem with the time. The
 * human says the slot is free on their own calendar. The agent must find the problem, record
 * the meeting at that time with manage_meetings action record (which resolves the problem), and
 * never send the prospect a confirmation through the engine: the human sends the invite.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  mailboxes,
  meetings,
  messages,
  problems,
  threads,
  workspaces,
} from "../../src/db/schema/index.js";
import { ingestInboundEmail } from "../../src/modules/email/inbound/ingest.js";
import {
  addDays,
  isoWeekday,
  localDate,
  zonedTimeToUtc,
} from "../../src/modules/email/timezone.js";
import { callsOf, describeCalls, mentionsAny, outcome } from "../harness/checks.js";
import { classifyReplyText } from "../harness/eval-brain.js";
import { check, defineScenario } from "../harness/types.js";
import { clearActivity, contactablePeople } from "./support.js";

const HOUR = 3_600_000;
const PROPOSAL = "Thanks, this looks useful. Tuesday at 3pm works for a quick call.";

interface BookingData {
  person_id: string;
  person_name: string;
  thread_id: string;
  problem_id: string;
  /** The proposed start (UTC ISO) and the same day as a local date. */
  start: string;
  day: string;
  before: string[];
}

/** The next Tuesday after today, 15:00 in the zone. */
function nextTuesdayAt3pm(now: Date, timeZone: string): Date {
  const today = localDate(now, timeZone);
  let day = addDays(today, 1);
  while (isoWeekday(day) !== 2) day = addDays(day, 1);
  return zonedTimeToUtc(day, 15, 0, timeZone);
}

export const bookAfterProposedTime = defineScenario<BookingData>({
  id: "book-after-proposed-time",
  title: "Record a meeting at the time a prospect proposed",
  prompt:
    "A Northwind prospect answered with a time for a call. I checked my own calendar (it lives outside OpenOutbound): that slot is free and I will take it. Get the meeting booked in OpenOutbound so nothing about it is left open. Do not send the prospect anything through OpenOutbound: I send the calendar invite myself. Tell me who it is and when.",
  toolsets: "core",
  maxTurns: 15,
  rubric: [
    "Finds the meeting_to_book problem in get_attention_queue (or get_operating_state) and reads the proposed time in it.",
    "Records the meeting with manage_meetings action record for that person at exactly the proposed time.",
    "Checks that the problem is closed afterwards (recording resolves it).",
    "Sends nothing: no reply drafted or sent, no confirmation email through the engine.",
    "Tells the human who and when, and that they send the invite themselves.",
  ],
  async setup(api) {
    const { workspaces: seeded } = await api.seedSandbox();
    const workspaceId = seeded.northwind as string;
    await clearActivity(api.db, workspaceId);
    await api.call(
      "workspaces.update",
      { settings: { booking: { mode: "handoff" } } },
      { workspace: workspaceId },
    );
    const [workspace] = await api.db
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const [mailbox] = await api.db
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.workspace_id, workspaceId), eq(mailboxes.status, "active")))
      .limit(1);
    const [person] = await contactablePeople(api.db, workspaceId, 1);
    if (!workspace || !mailbox || !person?.email) {
      throw new Error("book-after-proposed-time setup: sandbox mailbox or person missing");
    }
    const timeZone = workspace.timezone;
    const now = new Date();
    const start = nextTuesdayAt3pm(now, timeZone);
    // The classifier reads the proposed time out of this reply (other replies as usual).
    api.brain.on("inbox.reply.classify", (vars: { reply: string; subject: string | null }) => {
      const text = `${vars.subject ?? ""}\n${vars.reply}`;
      const proposed = vars.reply.includes("Tuesday at 3pm");
      const result = classifyReplyText(text);
      return {
        category: proposed ? "meeting_request" : result.category,
        confidence: proposed ? 0.93 : result.confidence,
        sentiment: proposed ? "positive" : result.sentiment,
        summary: proposed
          ? "Proposes Tuesday at 3pm for a quick call."
          : `The prospect's reply reads as ${result.category.replaceAll("_", " ")}.`,
        language: "en",
        return_date: null,
        follow_up_date: null,
        referral: null,
        question: null,
        left_company: false,
        asks_if_bot: false,
        suspicious: result.suspicious,
        proposed_time: proposed
          ? { text: "Tuesday at 3pm", start: start.toISOString(), timezone: timeZone }
          : null,
        privacy_kind: null,
        facts: [],
        company_hold: null,
      };
    });

    const subject = "reorder timing before peak season";
    const messageIdHeader = "<eval-booking-1@northwindanalytics.example.com>";
    const [thread] = await api.db
      .insert(threads)
      .values({
        workspace_id: workspaceId,
        person_id: person.id,
        company_id: person.company_id,
        channel: "email",
        subject,
        mailbox_id: mailbox.id,
        external_ref: messageIdHeader,
        status: "waiting",
        last_message_at: new Date(now.getTime() - 24 * HOUR),
      })
      .returning({ id: threads.id });
    if (!thread) throw new Error("book-after-proposed-time setup: thread insert failed");
    await api.db.insert(messages).values({
      workspace_id: workspaceId,
      thread_id: thread.id,
      person_id: person.id,
      company_id: person.company_id,
      channel: "email",
      action: "email",
      direction: "outbound",
      status: "sent",
      subject,
      body_text:
        "Hi, operations teams usually find stock problems after they cost sales. Worth a short look at where your gaps are?",
      from_address: mailbox.email,
      to_address: person.email,
      mailbox_id: mailbox.id,
      sent_at: new Date(now.getTime() - 24 * HOUR),
      message_id_header: messageIdHeader,
    });
    await ingestInboundEmail(await api.context(workspaceId), {
      mailboxId: mailbox.id,
      from: person.email,
      to: [mailbox.email],
      subject: `Re: ${subject}`,
      text: PROPOSAL,
      headers: {},
      messageIdHeader: "<eval-booking-reply-1@prospect.example.com>",
      inReplyTo: messageIdHeader,
      references: [messageIdHeader],
      receivedAt: new Date(now.getTime() - 2 * HOUR),
    });
    await api.runJobs();
    const [problem] = await api.db
      .select({ id: problems.id })
      .from(problems)
      .where(
        and(
          eq(problems.workspace_id, workspaceId),
          eq(problems.kind, "meeting_to_book"),
          eq(problems.person_id, person.id),
          eq(problems.status, "open"),
        ),
      );
    if (!problem) throw new Error("book-after-proposed-time setup: no meeting_to_book problem");
    const existing = await api.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.workspace_id, workspaceId));
    return {
      workspace: workspaceId,
      data: {
        person_id: person.id,
        person_name: person.full_name ?? person.email,
        thread_id: thread.id,
        problem_id: problem.id,
        start: start.toISOString(),
        day: localDate(start, timeZone),
        before: existing.map((row) => row.id),
      },
    };
  },
  async script(agent) {
    const queue = await agent.ok("get_attention_queue", {});
    const problem = (
      queue.problems.items as Array<{
        id: string;
        kind: string;
        person_id: string | null;
        title: string;
        reason: string;
      }>
    ).find((item) => item.kind === "meeting_to_book");
    if (!problem?.person_id) throw new Error("no meeting_to_book problem in the attention queue");
    const start = /read as ([^\s,]+?)\.(\s|$)/.exec(problem.reason)?.[1];
    if (!start) throw new Error(`no proposed time in: ${problem.reason}`);
    const lead = await agent.ok("get_lead", { action: "person", person_id: problem.person_id });
    const recorded = await agent.ok("manage_meetings", {
      action: "record",
      person_id: problem.person_id,
      start_at: start,
      notes: "Booked on the owner's calendar at the time the prospect proposed (Tuesday at 3pm).",
      reason: "The owner confirmed the slot is free on their calendar",
    });
    const after = await agent.ok("get_attention_queue", {});
    const stillOpen = (after.problems.items as Array<{ id: string }>).some(
      (item) => item.id === problem.id,
    );
    return [
      `${lead.person?.full_name ?? "The prospect"} (${lead.company?.name ?? "their company"}) proposed Tuesday at 3pm; the meeting is recorded for ${recorded.start_at} (meeting ${recorded.id}).`,
      `- The "${problem.title}" item is ${stillOpen ? "still open" : "closed"}.`,
      "- I sent nothing through OpenOutbound. Please send the calendar invite yourself.",
    ].join("\n");
  },
  assertions: [
    check("read the problem with the proposed time", ({ calls }) => {
      const looked = calls.filter((call) =>
        ["attention.get", "operating.state", "problems.list", "problems.get"].includes(
          call.operation,
        ),
      );
      return outcome(looked.length > 0, "never read the attention queue or the problems");
    }),
    check("recorded the meeting at the proposed time", async ({ db, workspaceId, data }) => {
      const rows = await db
        .select({ start_at: meetings.start_at, status: meetings.status })
        .from(meetings)
        .where(and(eq(meetings.workspace_id, workspaceId), eq(meetings.person_id, data.person_id)));
      const expected = Date.parse(data.start);
      const match = rows.find(
        (row) =>
          row.status === "scheduled" &&
          row.start_at !== null &&
          Math.abs(row.start_at.getTime() - expected) < 60_000,
      );
      return outcome(
        Boolean(match),
        `meetings: ${rows.map((row) => `${row.status} ${row.start_at?.toISOString()}`).join(", ") || "none"}; expected ${data.start}`,
      );
    }),
    check("recorded it with manage_meetings", ({ calls }) => {
      const records = callsOf(calls, "meetings.record", (call) => call.outcome === "ok");
      return outcome(
        records.length > 0,
        `record calls: ${describeCalls(callsOf(calls, "meetings.record"))}`,
      );
    }),
    check("the problem is resolved", async ({ db, data }) => {
      const [row] = await db
        .select({ status: problems.status })
        .from(problems)
        .where(eq(problems.id, data.problem_id));
      return outcome(row?.status === "resolved", `problem status ${row?.status ?? "missing"}`);
    }),
    check("sent the prospect nothing", async ({ db, workspaceId, data }) => {
      const rows = await db
        .select({ id: messages.id, status: messages.status })
        .from(messages)
        .where(
          and(
            eq(messages.workspace_id, workspaceId),
            eq(messages.direction, "outbound"),
            inArray(messages.status, [
              "draft",
              "pending_review",
              "approved",
              "scheduled",
              "sending",
              "sent",
            ]),
          ),
        );
      const fresh = rows.filter((row) => !data.before.includes(row.id));
      return outcome(
        fresh.length === 0,
        `${fresh.length} new outbound message(s): ${fresh.map((row) => row.status).join(", ")}`,
      );
    }),
    check("did not draft or send a confirmation", ({ calls }) => {
      const replies = calls.filter((call) =>
        ["threads.draft_reply", "threads.send_reply"].includes(call.operation),
      );
      return outcome(replies.length === 0, `reply calls: ${describeCalls(replies)}`);
    }),
    check("told the human who, when, and to send the invite", ({ finalText, data }) =>
      outcome(
        mentionsAny(finalText, ["tuesday", "3pm", "3 pm", "15:00", data.day]) &&
          mentionsAny(finalText, ["invite", "calendar"]) &&
          mentionsAny(finalText, ["yourself", "you send", "please send", "you will send"]),
        "expected the day and time and that the human sends the invite",
      ),
    ),
  ],
});
