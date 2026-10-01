import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { problems } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  getProblem,
  listProblems,
  type OpenProblemInput,
  openProblem,
  resolveProblem,
  resolveProblemsFor,
  snoozeProblem,
} from "./service.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const HOUR = 3_600_000;

function input(over: Partial<OpenProblemInput> = {}): OpenProblemInput {
  return {
    kind: "send_unknown",
    severity: "normal",
    title: "Check one email in the Sent folder",
    reason: "The mail server timed out after the email was handed over.",
    remedy: "Check the Sent folder, then mark the message sent or send it again.",
    ...over,
  };
}

async function row(ctx: TestContext, id: string) {
  const [found] = await ctx.db.select().from(problems).where(eq(problems.id, id));
  if (!found) throw new Error("problem row missing");
  return found;
}

async function titles(ctx: TestContext, filter: Parameters<typeof listProblems>[1] = {}) {
  return (await listProblems(ctx, filter)).items.map((item) => item.title);
}

describe("openProblem", () => {
  it("stores a problem with defaults and emits problem.opened", async () => {
    const ctx = await createTestContext({ db: testDb });
    const opened = await openProblem(
      ctx,
      input({
        subject: { type: "message", id: "msg_one" },
        personId: "pe_one",
        dueAt: new Date("2026-09-20T09:00:00Z"),
      }),
    );
    expect(opened).toEqual({ id: expect.stringMatching(/^pb_/), created: true });
    expect(await row(ctx, opened.id)).toMatchObject({
      workspace_id: ctx.workspace.id,
      kind: "send_unknown",
      severity: "normal",
      owner: "anyone",
      status: "open",
      subject_type: "message",
      subject_id: "msg_one",
      person_id: "pe_one",
      data: {},
      dedupe_key: null,
    });
    expect(ctx.emitted("problem.opened")).toEqual([
      {
        id: expect.any(String),
        subject: { type: "problem", id: opened.id },
        data: {
          problem_id: opened.id,
          kind: "send_unknown",
          severity: "normal",
          subject_type: "message",
          subject_id: "msg_one",
        },
      },
    ]);
  });

  it("updates an unresolved problem with the same key and only raises its severity", async () => {
    const ctx = await createTestContext({ db: testDb });
    const first = await openProblem(
      ctx,
      input({ dedupeKey: "send_unknown:msg_two", data: { checks: 1 } }),
    );
    const due = new Date("2026-09-21T10:00:00Z");
    const again = await openProblem(
      ctx,
      input({
        dedupeKey: "send_unknown:msg_two",
        severity: "low",
        title: "Still check one email",
        data: { checks: 2 },
        dueAt: due,
      }),
    );
    expect(again).toEqual({ id: first.id, created: false });
    expect(await row(ctx, first.id)).toMatchObject({
      severity: "normal",
      title: "Still check one email",
      data: { checks: 2 },
      due_at: due,
    });

    await openProblem(ctx, input({ dedupeKey: "send_unknown:msg_two", severity: "urgent" }));
    const escalated = await row(ctx, first.id);
    expect(escalated.severity).toBe("urgent");
    // Omitted data and due time are kept.
    expect(escalated).toMatchObject({ data: { checks: 2 }, due_at: due });
    expect(ctx.emitted("problem.opened")).toHaveLength(1);
    expect(await ctx.db.select().from(problems).where(eq(problems.id, first.id))).toHaveLength(1);
  });

  it("merges the data of a refresh, keeping keys the new data leaves out", async () => {
    const ctx = await createTestContext({ db: testDb });
    const first = await openProblem(
      ctx,
      input({ dedupeKey: "privacy_request:msg_merge", data: { kind: "delete", due_at: "a" } }),
    );
    // A reminder job remembers what it already sent.
    await ctx.db
      .update(problems)
      .set({ data: { kind: "delete", due_at: "a", reminded_at: "2026-09-20T08:05:00.000Z" } })
      .where(eq(problems.id, first.id));
    await openProblem(
      ctx,
      input({ dedupeKey: "privacy_request:msg_merge", data: { kind: "access", due_at: "b" } }),
    );
    expect((await row(ctx, first.id)).data).toEqual({
      kind: "access",
      due_at: "b",
      reminded_at: "2026-09-20T08:05:00.000Z",
    });
  });

  it("never refreshes a problem resolved meanwhile: it opens a new one", async () => {
    const ctx = await createTestContext({ db: testDb });
    const first = await openProblem(ctx, input({ dedupeKey: "send_unknown:msg_race" }));
    // Someone resolves it between the lookup and the refresh.
    let raced = false;
    const racing = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === "update" && !raced) {
          raced = true;
          return (table: typeof problems) => ({
            set: (values: Record<string, unknown>) => ({
              where: (
                where: Parameters<ReturnType<ReturnType<Db["update"]>["set"]>["where"]>[0],
              ) => ({
                returning: async (fields: Record<string, unknown>) => {
                  await resolveProblem(ctx, first.id, { resolution: "Checked." });
                  return target
                    .update(table)
                    .set(values)
                    .where(where)
                    .returning(fields as never);
                },
              }),
            }),
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const again = await openProblem(
      { ...ctx, db: racing },
      input({ dedupeKey: "send_unknown:msg_race" }),
    );
    expect(raced).toBe(true);
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(first.id);
    expect(await row(ctx, first.id)).toMatchObject({ status: "resolved", resolution: "Checked." });
    expect(await row(ctx, again.id)).toMatchObject({ status: "open" });
  });

  it("opens a new problem once the old one with that key is resolved", async () => {
    const ctx = await createTestContext({ db: testDb });
    const first = await openProblem(ctx, input({ dedupeKey: "mailbox_down:mbx_1" }));
    await resolveProblem(ctx, first.id, { resolution: "Reconnected." });
    const second = await openProblem(ctx, input({ dedupeKey: "mailbox_down:mbx_1" }));
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
  });

  it("creates one problem when two callers open the same key at once", async () => {
    const ctx = await createTestContext({ db: testDb });
    const results = await Promise.all([
      openProblem(ctx, input({ dedupeKey: "dns_failed:example.org" })),
      openProblem(ctx, input({ dedupeKey: "dns_failed:example.org", severity: "high" })),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect((await row(ctx, results[0]?.id ?? "")).severity).toBe("high");
  });

  it("needs a title, a reason and a remedy", async () => {
    const ctx = await createTestContext({ db: testDb });
    await expect(openProblem(ctx, input({ title: "   " }))).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "title" },
    });
    await expect(openProblem(ctx, input({ remedy: "" }))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("resolving", () => {
  it("resolves once, records who resolved it and emits problem.resolved once", async () => {
    const ctx = await createTestContext({ db: testDb });
    const { id } = await openProblem(ctx, input());
    expect(await resolveProblem(ctx, id, { resolution: " Found it in Sent. " })).toEqual({
      resolved: true,
    });
    expect(await resolveProblem(ctx, id)).toEqual({ resolved: false });
    const resolved = await row(ctx, id);
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "Found it in Sent.",
      resolved_by: { type: "human", id: "usr_test", name: "Test User", via: "cli" },
    });
    expect(resolved.resolved_at?.toISOString()).toBe(ctx.clock.now().toISOString());
    expect(ctx.emitted("problem.resolved").map((event) => event.data)).toEqual([
      { problem_id: id, kind: "send_unknown", resolution: "Found it in Sent." },
    ]);
  });

  it("refuses ids it does not know", async () => {
    const ctx = await createTestContext({ db: testDb });
    await expect(resolveProblem(ctx, "pb_missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("resolves every unresolved match of the filter and needs at least one field", async () => {
    const ctx = await createTestContext({ db: testDb });
    const message = await openProblem(
      ctx,
      input({ subject: { type: "message", id: "msg_a" }, personId: "pe_a" }),
    );
    const other = await openProblem(
      ctx,
      input({ subject: { type: "message", id: "msg_b" }, personId: "pe_a" }),
    );
    const privacy = await openProblem(
      ctx,
      input({ kind: "privacy_request", severity: "urgent", personId: "pe_a" }),
    );
    await expect(resolveProblemsFor(ctx, {}, "Done")).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(
      await resolveProblemsFor(ctx, { subjectType: "message", subjectId: "msg_a" }, "Sent"),
    ).toBe(1);
    expect((await row(ctx, message.id)).status).toBe("resolved");
    expect((await row(ctx, other.id)).status).toBe("open");
    // Kind and person together: both must match.
    expect(
      await resolveProblemsFor(ctx, { kind: "send_unknown", personId: "pe_a" }, "Checked"),
    ).toBe(1);
    expect((await row(ctx, privacy.id)).status).toBe("open");
    expect(await resolveProblemsFor(ctx, { personId: "pe_a" }, "Forgotten")).toBe(1);
    expect(await resolveProblemsFor(ctx, { personId: "pe_a" }, "Again")).toBe(0);
    expect(ctx.emitted("problem.resolved")).toHaveLength(3);
  });
});

describe("snoozing", () => {
  it("hides a problem until its time passes, then it counts as open again", async () => {
    const ctx = await createTestContext({ db: testDb });
    const { id } = await openProblem(ctx, input({ title: "Snoozed one" }));
    await snoozeProblem(ctx, id, new Date(ctx.clock.now().getTime() + 2 * HOUR));
    expect(await titles(ctx)).toEqual([]);
    expect(await titles(ctx, { statuses: ["snoozed"] })).toEqual(["Snoozed one"]);
    expect((await getProblem(ctx, id))?.status).toBe("snoozed");

    ctx.clock.advance(2 * HOUR);
    expect(await titles(ctx)).toEqual(["Snoozed one"]);
    expect(await titles(ctx, { statuses: ["snoozed"] })).toEqual([]);
    const woken = await getProblem(ctx, id);
    expect(woken).toMatchObject({ status: "open" });
    expect(woken?.snoozed_until).toBeInstanceOf(Date);
  });

  it("refuses past times, resolved problems and unknown ids", async () => {
    const ctx = await createTestContext({ db: testDb });
    const { id } = await openProblem(ctx, input());
    await expect(snoozeProblem(ctx, id, ctx.clock.now())).rejects.toMatchObject({
      code: "validation_failed",
    });
    await resolveProblem(ctx, id);
    const later = new Date(ctx.clock.now().getTime() + HOUR);
    await expect(snoozeProblem(ctx, id, later)).rejects.toMatchObject({ code: "conflict" });
    await expect(snoozeProblem(ctx, "pb_missing", later)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("never hides a problem past its due time, nor an urgent one for more than a day", async () => {
    const ctx = await createTestContext({ db: testDb });
    const at = (hours: number) => new Date(ctx.clock.now().getTime() + hours * HOUR);
    const privacy = await openProblem(
      ctx,
      input({ kind: "privacy_request", severity: "high", dueAt: at(72) }),
    );
    const late = await snoozeProblem(ctx, privacy.id, at(96)).catch((error: unknown) => error);
    expect(late).toMatchObject({
      code: "validation_failed",
      details: { due_at: at(72).toISOString() },
    });
    expect((late as Error).message).toContain(
      `due ${at(72).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    );
    await snoozeProblem(ctx, privacy.id, at(72));
    expect((await row(ctx, privacy.id)).snoozed_until).toEqual(at(72));

    // Overdue: no snooze at all.
    const overdue = await openProblem(ctx, input({ severity: "high", dueAt: at(-1) }));
    await expect(snoozeProblem(ctx, overdue.id, at(1))).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("do its remedy now"),
    });

    const urgent = await openProblem(ctx, input({ severity: "urgent" }));
    await expect(snoozeProblem(ctx, urgent.id, at(25))).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("at most 24 hours"),
    });
    await snoozeProblem(ctx, urgent.id, at(24));
    expect((await row(ctx, urgent.id)).status).toBe("snoozed");
  });
});

describe("listProblems", () => {
  it("orders by severity, then due time with none last, then age, across pages", async () => {
    const ctx = await createTestContext({ db: testDb });
    const at = (hours: number) => new Date(ctx.clock.now().getTime() + hours * HOUR);
    await openProblem(ctx, input({ title: "low, no due", severity: "low" }));
    await openProblem(ctx, input({ title: "normal, no due" }));
    await openProblem(ctx, input({ title: "normal, due later", dueAt: at(10) }));
    await openProblem(ctx, input({ title: "urgent, no due", severity: "urgent" }));
    await openProblem(ctx, input({ title: "normal, due soon", dueAt: at(1) }));
    await openProblem(ctx, input({ title: "high, due later", severity: "high", dueAt: at(5) }));
    await openProblem(ctx, input({ title: "normal, no due, newer" }));
    const expected = [
      "urgent, no due",
      "high, due later",
      "normal, due soon",
      "normal, due later",
      "normal, no due",
      "normal, no due, newer",
      "low, no due",
    ];
    expect(await titles(ctx)).toEqual(expected);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result: Awaited<ReturnType<typeof listProblems>> = await listProblems(ctx, {
        limit: 3,
        cursor,
      });
      seen.push(...result.items.map((item) => item.title));
      expect(result.has_more).toBe(result.next_cursor !== null);
      cursor = result.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(expected);
  });

  it("filters by status, kind and person, and rejects foreign cursors", async () => {
    const ctx = await createTestContext({ db: testDb });
    const done = await openProblem(ctx, input({ title: "resolved one" }));
    await resolveProblem(ctx, done.id);
    await openProblem(ctx, input({ title: "privacy", kind: "privacy_request", personId: "pe_x" }));
    await openProblem(ctx, input({ title: "unknown send", personId: "pe_y" }));
    expect(await titles(ctx, { statuses: ["resolved"] })).toEqual(["resolved one"]);
    expect(await titles(ctx, { kinds: ["privacy_request"] })).toEqual(["privacy"]);
    expect(await titles(ctx, { personId: "pe_y" })).toEqual(["unknown send"]);
    expect(await titles(ctx, { statuses: [] })).toEqual([]);
    expect(
      (await titles(ctx, { statuses: ["open", "resolved"] })).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["privacy", "resolved one", "unknown send"]);
    await expect(listProblems(ctx, { cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("workspace isolation", () => {
  it("never reads, resolves or snoozes another workspace's problems", async () => {
    const mine = await createTestContext({ db: testDb });
    const theirs = await createTestContext({ db: testDb });
    const { id } = await openProblem(theirs, input({ title: "theirs", dedupeKey: "shared-key" }));
    // The same key in another workspace is another problem.
    expect(
      (await openProblem(mine, input({ title: "mine", dedupeKey: "shared-key" }))).created,
    ).toBe(true);
    expect(await titles(mine)).toEqual(["mine"]);
    expect(await getProblem(mine, id)).toBeNull();
    await expect(resolveProblem(mine, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      snoozeProblem(mine, id, new Date(mine.clock.now().getTime() + HOUR)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await resolveProblemsFor(mine, { dedupeKey: "shared-key" }, "Mine only")).toBe(1);
    expect((await getProblem(theirs, id))?.status).toBe("open");
  });
});
