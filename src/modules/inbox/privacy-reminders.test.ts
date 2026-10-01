/**
 * Daily privacy deadline reminders: once when 7 days or fewer remain, once a day when overdue
 * (title raised), resolved and snoozed problems skipped, one workspace at a time.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { problems } from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { openProblem, resolveProblem, snoozeProblem } from "../problems/service.js";
import { privacyRemindersJob, sendPrivacyReminders } from "./privacy-reminders.js";
import { buildPrivacyProblem, type PrivacyProblemInput } from "./privacy-requests.js";

vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

const DAY = 86_400_000;
let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(() => {
  vi.mocked(notify).mockClear();
});

let counter = 0;
/** Opens a privacy request problem received at `receivedAt` (30 days to answer). */
async function openRequest(ctx: TestContext, receivedAt: Date): Promise<string> {
  counter += 1;
  const input: PrivacyProblemInput = {
    kind: "delete",
    personId: null,
    companyId: null,
    name: "Dana Reyes",
    label: "Dana Reyes (Harbor Dental)",
    firstName: "Dana",
    address: "dana@harbor-dental.example.com",
    messageId: `msg_reminder_${counter}`,
    threadId: null,
    receivedAt,
    responseDays: 30,
    timeZone: "UTC",
    source: { line: "Apollo, a business contact database, on 3 Sep 2026", quotable: true },
  };
  const opened = await openProblem(ctx, buildPrivacyProblem(input));
  return opened.id;
}

async function row(ctx: TestContext, id: string) {
  const [found] = await ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.id, id)));
  if (!found) throw new Error(`problem ${id} missing`);
  return found;
}

function notified(): Array<{ title: string; lines: string[]; severity?: string }> {
  return vi.mocked(notify).mock.calls.map(([, input]) => input as never);
}

describe("sendPrivacyReminders", () => {
  it("reminds once when 7 days or fewer remain", async () => {
    const ctx = await createTestContext({ db: testDb });
    const now = ctx.clock.now();
    // Due in 7 days: received 23 days ago.
    const id = await openRequest(ctx, new Date(now.getTime() - 23 * DAY));
    // Due in 8 days: nothing yet.
    const later = await openRequest(ctx, new Date(now.getTime() - 22 * DAY));

    expect(await sendPrivacyReminders(ctx)).toEqual({ checked: 2, reminded: 1, overdue: 0 });
    expect(notified()).toEqual([
      {
        title: "Privacy request from Dana Reyes (Harbor Dental): delete their data (7 days left)",
        lines: [
          expect.stringMatching(
            /^Dana Reyes asked to delete their data on .* Answer by 26 Sep 2026\./,
          ),
          expect.stringMatching(
            /^Next step: Reply to them yourself \(suggested text below\), then run manage_leads action forget with email dana@harbor-dental\.example\.com/,
          ),
          `Problem ${id}`,
        ],
        severity: "warning",
      },
    ]);
    const reminded = await row(ctx, id);
    expect(reminded.data.reminded_at).toBe(now.toISOString());
    expect(reminded.data.suggested_reply).toMatch(/^Hi Dana, understood\./);
    expect(reminded.title).not.toMatch(/Overdue/);
    expect((await row(ctx, later)).data.reminded_at).toBeUndefined();

    // Same day and the next day: no second reminder for the first; the second one is due now.
    vi.mocked(notify).mockClear();
    await sendPrivacyReminders(ctx);
    expect(notified()).toEqual([]);
    ctx.clock.advanceBy({ days: 1 });
    expect(await sendPrivacyReminders(ctx)).toEqual({ checked: 2, reminded: 1, overdue: 0 });
    expect(notified().map((call) => call.title)).toEqual([
      "Privacy request from Dana Reyes (Harbor Dental): delete their data (7 days left)",
    ]);
    expect((await row(ctx, later)).data.reminded_at).toBe(ctx.clock.now().toISOString());
  });

  it("says one day when less than a day remains", async () => {
    const ctx = await createTestContext({ db: testDb });
    const now = ctx.clock.now();
    await openRequest(ctx, new Date(now.getTime() - 30 * DAY + 3_600_000));
    await sendPrivacyReminders(ctx);
    expect(notified()[0]?.title).toMatch(/\(1 day left\)$/);
  });

  it("notifies once a day when overdue and raises the title", async () => {
    const ctx = await createTestContext({ db: testDb });
    const now = ctx.clock.now();
    // Due 2 days ago.
    const id = await openRequest(ctx, new Date(now.getTime() - 32 * DAY));

    expect(await sendPrivacyReminders(ctx)).toEqual({ checked: 1, reminded: 0, overdue: 1 });
    expect(notified()).toEqual([
      {
        title: "Overdue: Privacy request from Dana Reyes (Harbor Dental): delete their data",
        lines: [
          "The answer was due on 17 Sep 2026, 2 days ago.",
          expect.stringContaining("Answer by 17 Sep 2026."),
          expect.stringMatching(/^Next step: Reply to them yourself/),
          `Problem ${id}`,
        ],
        severity: "critical",
      },
    ]);
    const overdue = await row(ctx, id);
    expect(overdue.title).toBe(
      "Overdue: Privacy request from Dana Reyes (Harbor Dental): delete their data",
    );
    expect(overdue.status).toBe("open");
    expect(overdue.severity).toBe("urgent");
    expect(overdue.data).toMatchObject({
      overdue_notified_on: "2026-09-19",
      overdue_since: "2026-09-17T12:00:00.000Z",
    });

    // A second run the same day stays quiet.
    vi.mocked(notify).mockClear();
    expect(await sendPrivacyReminders(ctx)).toEqual({ checked: 1, reminded: 0, overdue: 0 });
    expect(notified()).toEqual([]);

    // The next day it comes again, without doubling the prefix.
    ctx.clock.advanceBy({ days: 1 });
    await sendPrivacyReminders(ctx);
    expect(notified().map((call) => call.title)).toEqual([
      "Overdue: Privacy request from Dana Reyes (Harbor Dental): delete their data",
    ]);
    expect(notified()[0]?.lines[0]).toBe("The answer was due on 17 Sep 2026, 3 days ago.");
    expect((await row(ctx, id)).data.overdue_notified_on).toBe("2026-09-20");
  });

  it("skips resolved problems and snoozed ones until the snooze ends", async () => {
    const ctx = await createTestContext({ db: testDb });
    const now = ctx.clock.now();
    const resolved = await openRequest(ctx, new Date(now.getTime() - 40 * DAY));
    await resolveProblem(ctx, resolved, { resolution: "answered" });
    // Due in half a day: a request can be snoozed until its due time, never past it.
    const snoozed = await openRequest(ctx, new Date(now.getTime() - 29.5 * DAY));
    await snoozeProblem(ctx, snoozed, new Date(now.getTime() + DAY / 2));

    expect(await sendPrivacyReminders(ctx)).toEqual({ checked: 0, reminded: 0, overdue: 0 });
    expect(notified()).toEqual([]);
    const untouched = await row(ctx, resolved);
    expect(untouched.title).not.toMatch(/^Overdue/);
    expect(untouched.data.overdue_notified_on).toBeUndefined();

    ctx.clock.advanceBy({ days: 1 });
    expect(await sendPrivacyReminders(ctx)).toEqual({ checked: 1, reminded: 0, overdue: 1 });
    expect(notified()[0]?.title).toMatch(/^Overdue: /);
  });

  it("ignores other problem kinds and other workspaces", async () => {
    const ctx = await createTestContext({ db: testDb });
    const other = await createTestContext({ db: testDb });
    const now = ctx.clock.now();
    const theirs = await openRequest(other, new Date(now.getTime() - 40 * DAY));
    await openProblem(ctx, {
      kind: "send_unknown",
      severity: "high",
      title: "A send may not have gone out",
      reason: "The server stopped before the send finished.",
      remedy: "Check the Sent folder.",
      dueAt: new Date(now.getTime() - DAY),
    });

    expect(await sendPrivacyReminders(ctx)).toEqual({ checked: 0, reminded: 0, overdue: 0 });
    expect(notified()).toEqual([]);
    expect((await row(other, theirs)).title).not.toMatch(/^Overdue/);
  });

  it("runs as a job for the job's workspace", async () => {
    const ctx = await createTestContext({ db: testDb });
    await openRequest(ctx, new Date(ctx.clock.now().getTime() - 31 * DAY));
    await expect(privacyRemindersJob.handler(ctx.jobContext(), {})).resolves.toEqual({
      checked: 1,
      reminded: 0,
      overdue: 1,
    });
  });
});
