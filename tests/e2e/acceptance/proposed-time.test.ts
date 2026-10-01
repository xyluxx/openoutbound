/**
 * Acceptance scenario 14, a proposed time. Noor Aziz answers the first email: "Tuesday at 3pm
 * works for a quick call." The engine never accepts or confirms a time itself.
 * - link mode (the client lets meeting replies go out on their own): the reply offers the
 *   booking link tagged with her booking code and goes out without review; it does not confirm
 *   the time. A draft that does confirm it fails the checker (the rule is in the checker's
 *   prompt) and waits for a person instead of going out.
 * - handoff mode (a person books every meeting): no scheduling reply is drafted at all, and a
 *   meeting_to_book problem shows the proposed time. Recording the meeting with
 *   manage_meetings action record resolves it.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { approvals, meetings, opportunities, people } from "../../../src/db/schema/index.js";
import { NO_CONFIRMED_TIME_RULE } from "../../../src/modules/inbox/prompts/check.js";
import {
  type Any,
  BOOKING_URL,
  classification,
  createCampaign,
  enrollAndLaunch,
  enrollmentsOf,
  eventsOf,
  firstEmailSent,
  messagesOf,
  PASSING_CHECK,
  problemsOf,
  receiveReply,
  replyDraft,
  startWorld,
  until,
  type World,
  type WorldOptions,
} from "./support.js";

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const EMAIL = "noor.aziz@riverbend-dental.example.com";
const PROPOSAL = "Tuesday at 3pm works for a quick call.";
const PROPOSED = {
  text: "Tuesday at 3pm",
  start: "2026-09-29T15:00:00-05:00",
  timezone: "America/Chicago",
};

/** A world where Noor got the first email and answered with a time. */
async function noorProposesATime(settings: WorldOptions["settings"]) {
  const current = await startWorld({ settings });
  world = current;
  const { person } = await current.lead({
    person: { first_name: "Noor", last_name: "Aziz", full_name: "Noor Aziz", email: EMAIL },
    company: { name: "Riverbend Dental", domain: "riverbend-dental.example.com" },
  });
  const campaign = await createCampaign(current, { name: "Riverbend area practices" });
  await enrollAndLaunch(current, campaign.id, [person.id]);
  const first = await firstEmailSent(current, person.id);
  current.classifyReply(
    "tuesday at 3pm",
    classification("meeting_request", { proposed_time: PROPOSED }),
  );
  return { world: current, person, campaign, first };
}

async function bookingRef(current: World, personId: string): Promise<string> {
  const [row] = await current.engine.db.select().from(people).where(eq(people.id, personId));
  return row?.booking_ref ?? "";
}

/** The checker as the rule in its prompt asks: a draft that confirms a time is sent back. */
function checkerApplyingTheTimeRule(vars: { body: string }) {
  return /\b(works|see you|confirmed)\b/i.test(vars.body) && /3\s?pm|tuesday/i.test(vars.body)
    ? {
        verdict: "revise",
        confidence: 0.93,
        issues: [{ code: "confirms_time", message: "The draft confirms Tuesday at 3pm." }],
      }
    : PASSING_CHECK;
}

describe("acceptance: proposed time", () => {
  it("link mode: answers with her tagged booking link on its own, never confirming the time", async () => {
    const {
      world: current,
      person,
      first,
    } = await noorProposesATime({
      replies: { meeting_request: { action: "auto_reply" } },
    });
    current.brain.on("inbox.reply.check", checkerApplyingTheTimeRule);
    const reply = await receiveReply(current, first, PROPOSAL);

    // The reply offers her tagged link and goes out without review.
    const ref = await bookingRef(current, person.id);
    expect(ref).toMatch(/^bk[0-9a-z]{10}$/);
    let answer: Any;
    await until(current.engine, "the reply goes out", async () => {
      const rows = await messagesOf(current, { threadId: reply.threadId, direction: "outbound" });
      answer = rows.find((row) => row.action === "reply" && row.status === "sent");
      return Boolean(answer);
    });
    expect(answer.body_text).toContain(`${BOOKING_URL}?utm_content=${ref}&utm_source=openoutbound`);
    expect(answer.body_text).not.toMatch(/3\s?pm|tuesday/i);
    const reviews = await current.engine.db
      .select()
      .from(approvals)
      .where(eq(approvals.target_id, answer.id));
    expect(reviews).toEqual([]);

    // The checker saw the rule; nothing was booked by the engine.
    const checks = current.brain.calls.filter((call) => call.promptId === "inbox.reply.check");
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]?.system).toContain(NO_CONFIRMED_TIME_RULE);
    expect(
      await current.engine.db.select().from(meetings).where(eq(meetings.person_id, person.id)),
    ).toEqual([]);

    // Someone still owns the time she proposed, in case she does not use the link.
    const [problem] = await problemsOf(current, "meeting_to_book");
    expect(problem).toMatchObject({ status: "open", severity: "normal", person_id: person.id });
    expect(problem?.reason).toContain(
      'proposed a meeting time, quoted from their reply: "Tuesday at 3pm" (America/Chicago), read as 2026-09-29T15:00:00-05:00.',
    );
  });

  it("link mode: a draft that confirms the time fails the checker and waits for a person", async () => {
    const { world: current, first } = await noorProposesATime({
      replies: { meeting_request: { action: "auto_reply" } },
    });
    current.brain.on("inbox.reply.check", checkerApplyingTheTimeRule);
    current.brain.on("inbox.reply.draft", (vars: Any) => ({
      ...replyDraft(vars),
      body: `Hi Noor, Tuesday at 3pm works, see you then. The invite link, in case: ${vars.bookingUrl}`,
    }));
    const reply = await receiveReply(current, first, PROPOSAL);

    const drafts = (
      await messagesOf(current, { threadId: reply.threadId, direction: "outbound" })
    ).filter((row) => row.action === "reply");
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft?.status).toBe("pending_review");
    expect(draft?.check).toMatchObject({ passed: false });
    expect(JSON.stringify(draft?.check)).toContain("confirms_time");
    const [review] = await current.engine.db
      .select()
      .from(approvals)
      .where(eq(approvals.target_id, draft?.id ?? ""));
    expect(review).toMatchObject({ kind: "reply", status: "pending" });
    expect(await eventsOf(current, "message.sent")).toHaveLength(1);
  });

  it("handoff mode: drafts nothing, shows the proposed time in a problem, and record resolves it", async () => {
    const {
      world: current,
      person,
      campaign,
      first,
    } = await noorProposesATime({
      booking: { mode: "handoff" },
    });
    const reply = await receiveReply(current, first, PROPOSAL);

    // No scheduling reply at all, and her sequence stopped.
    const outbound = await messagesOf(current, { threadId: reply.threadId, direction: "outbound" });
    expect(outbound.filter((row) => row.action === "reply")).toEqual([]);
    expect(
      current.brain.calls.filter((call) => call.promptId === "inbox.reply.draft"),
    ).toHaveLength(0);
    expect(await enrollmentsOf(current, person.id)).toMatchObject([
      { campaign_id: campaign.id, status: "stopped" },
    ]);

    // A problem for someone to book it, with the time she proposed.
    const [problem] = await problemsOf(current, "meeting_to_book");
    expect(problem).toMatchObject({
      status: "open",
      severity: "high",
      person_id: person.id,
      title: "Book a meeting with Noor Aziz (Riverbend Dental)",
      dedupe_key: `meeting_to_book:${person.id}`,
    });
    expect(problem?.reason).toContain(
      'Noor Aziz (Riverbend Dental) proposed a meeting time, quoted from their reply: "Tuesday at 3pm" (America/Chicago), read as 2026-09-29T15:00:00-05:00.',
    );
    expect(problem?.reason).toContain("Booking mode is handoff");
    expect(problem?.data).toMatchObject({ booking_mode: "handoff", proposed_time: PROPOSED });
    expect(problem?.due_at?.toISOString()).toBe("2026-09-29T20:00:00.000Z");
    expect(problem?.remedy).toContain(`manage_meetings action record (person_id ${person.id}`);
    const state = await current.call<Any>("operating.state");
    expect(state.problems.top).toContainEqual(
      expect.objectContaining({ id: problem?.id, kind: "meeting_to_book", severity: "high" }),
    );

    // A person booked it on the calendar and records it: the problem resolves.
    const recorded = await current.call<Any>("meetings.record", {
      person_id: person.id,
      start_at: "2026-09-29T15:00:00-05:00",
      end_at: "2026-09-29T15:30:00-05:00",
      notes: "Booked by the team after she proposed Tuesday at 3pm.",
    });
    expect(recorded).toMatchObject({ created: true, status: "scheduled", source: "manual" });
    const [closed] = await problemsOf(current, "meeting_to_book");
    expect(closed?.status).toBe("resolved");
    const opps = await current.engine.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.person_id, person.id));
    expect(opps.map((row) => row.stage)).toEqual(["meeting_booked"]);
    expect(await eventsOf(current, "meeting.booked")).toHaveLength(1);
    const lead = await current.call<Any>("leads.get", { person_id: person.id });
    expect(lead.relationship).toMatchObject({
      state: "meeting_scheduled",
      next_action: { kind: "meeting", ref: { type: "meeting", id: recorded.id } },
    });
  });
});
