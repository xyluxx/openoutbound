import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { messages, workspaces } from "../../db/schema/index.js";
import type { LinkedInPost, LinkedInProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount, seedMessage, seedPerson } from "../../testing/factories.js";
import { bumpCounter } from "./capacity.js";
import { upsertRelation } from "./relations.js";
import {
  getRecentPostForPerson,
  getRelation,
  planLinkedInAction,
  queueLinkedInAction,
} from "./service.js";

vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

/** Tuesday 2026-09-22 10:00 in Chicago. */
const NOW = "2026-09-22T15:00:00.000Z";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function context(over: Parameters<typeof createTestContext>[0] = {}): Promise<TestContext> {
  return createTestContext({ db, now: NOW, ...over });
}

function fakeProvider(posts: LinkedInPost[] = []) {
  return {
    id: "unipile",
    getProfile: vi.fn(async () => ({ provider_id: "ACoAA1", profile_url: "" })),
    visitProfile: vi.fn(async () => {}),
    sendInvite: vi.fn(async () => ({})),
    sendMessage: vi.fn(async () => ({ messageId: "m1" })),
    listRecentPosts: vi.fn(async () => posts),
    reactToPost: vi.fn(async () => {}),
    commentOnPost: vi.fn(async () => ({})),
  } satisfies LinkedInProvider;
}

describe("planLinkedInAction", () => {
  it("refuses when the workspace is paused", async () => {
    const ctx = await context({ workspace: { status: "paused" } });
    const account = await seedLinkedInAccount(ctx);
    expect(await planLinkedInAction(ctx, { accountIds: [account.id], action: "invite" })).toEqual({
      ok: false,
      reason: "workspace_paused",
    });
  });

  it("treats an archived workspace like a paused one", async () => {
    const ctx = await context({ workspace: { status: "archived" } });
    const account = await seedLinkedInAccount(ctx);
    expect(await planLinkedInAction(ctx, { accountIds: [account.id], action: "visit" })).toEqual({
      ok: false,
      reason: "workspace_paused",
    });
  });

  it("needs an active account from the list in this workspace", async () => {
    const ctx = await context();
    const other = await context();
    const paused = await seedLinkedInAccount(ctx, { status: "restricted" });
    const foreign = await seedLinkedInAccount(other);
    expect(await planLinkedInAction(ctx, { accountIds: [], action: "visit" })).toEqual({
      ok: false,
      reason: "no_active_account",
    });
    expect(
      await planLinkedInAction(ctx, { accountIds: [paused.id, foreign.id], action: "visit" }),
    ).toEqual({ ok: false, reason: "no_active_account" });
  });

  it("plans now inside working hours", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx);
    expect(await planLinkedInAction(ctx, { accountIds: [account.id], action: "invite" })).toEqual({
      ok: true,
      accountId: account.id,
      runAt: new Date(NOW),
    });
  });

  it("returns outside_hours with the next Monday slot on weekends", async () => {
    const ctx = await context({ now: "2026-09-19T12:00:00Z" });
    const account = await seedLinkedInAccount(ctx);
    expect(await planLinkedInAction(ctx, { accountIds: [account.id], action: "message" })).toEqual({
      ok: false,
      reason: "outside_hours",
      retryAt: new Date("2026-09-21T14:00:00Z"),
    });
  });

  it("uses the account timezone, not the server's", async () => {
    // 15:00 UTC is midnight in Tokyo: outside 9-18 there, so the next slot is 09:00 Tokyo.
    const ctx = await context();
    const tokyo = await seedLinkedInAccount(ctx, { timezone: "Asia/Tokyo" });
    const result = await planLinkedInAction(ctx, { accountIds: [tokyo.id], action: "visit" });
    expect(result).toEqual({
      ok: false,
      reason: "outside_hours",
      retryAt: new Date("2026-09-23T00:00:00Z"),
    });
  });

  it("prefers the preferred account, else the least used one", async () => {
    const ctx = await context();
    const busy = await seedLinkedInAccount(ctx);
    const idle = await seedLinkedInAccount(ctx);
    await bumpCounter(ctx.db, busy.id, "2026-09-22", "invite", 3);
    const least = await planLinkedInAction(ctx, {
      accountIds: [busy.id, idle.id],
      action: "invite",
    });
    expect(least).toMatchObject({ ok: true, accountId: idle.id });
    const preferred = await planLinkedInAction(ctx, {
      accountIds: [busy.id, idle.id],
      preferredAccountId: busy.id,
      action: "invite",
    });
    expect(preferred).toMatchObject({ ok: true, accountId: busy.id });
  });

  it("falls back to another account when the preferred one is full", async () => {
    const ctx = await context();
    const full = await seedLinkedInAccount(ctx);
    const spare = await seedLinkedInAccount(ctx);
    await bumpCounter(ctx.db, full.id, "2026-09-22", "invite", 15);
    const result = await planLinkedInAction(ctx, {
      accountIds: [full.id, spare.id],
      preferredAccountId: full.id,
      action: "invite",
    });
    expect(result).toMatchObject({ ok: true, accountId: spare.id });
    const alone = await planLinkedInAction(ctx, { accountIds: [full.id], action: "invite" });
    expect(alone).toEqual({
      ok: false,
      reason: "no_capacity",
      retryAt: new Date("2026-09-23T14:00:00Z"),
    });
  });

  it("spaces actions with a gap after reserved slots", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx);
    const person = await seedPerson(ctx);
    await seedMessage(ctx, {
      channel: "linkedin",
      action: "visit",
      status: "scheduled",
      linkedin_account_id: account.id,
      person_id: person.id,
      scheduled_for: new Date(NOW),
    });
    const result = await planLinkedInAction(ctx, { accountIds: [account.id], action: "invite" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const gap = result.runAt.getTime() - new Date(NOW).getTime();
      expect(gap).toBeGreaterThanOrEqual(2 * 60_000);
      expect(gap).toBeLessThanOrEqual(12 * 60_000);
    }
  });

  it("applies the ramp of a new account", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx, {
      ramp: { enabled: true, start: 40, increment: 30, every_days: 7, started_at: "2026-09-22" },
    });
    await bumpCounter(ctx.db, account.id, "2026-09-22", "invite", 6);
    expect(
      await planLinkedInAction(ctx, { accountIds: [account.id], action: "invite" }),
    ).toMatchObject({
      ok: false,
      reason: "no_capacity",
    });
  });

  it("respects notBefore", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx);
    const later = new Date("2026-09-22T18:30:00Z");
    expect(
      await planLinkedInAction(ctx, {
        accountIds: [account.id],
        action: "visit",
        notBefore: later,
      }),
    ).toEqual({ ok: true, accountId: account.id, runAt: later });
  });
});

describe("queueLinkedInAction", () => {
  async function approved(ctx: TestContext, accountId: string, over = {}) {
    const person = await seedPerson(ctx);
    return seedMessage(ctx, {
      channel: "linkedin",
      action: "invite",
      status: "approved",
      linkedin_account_id: accountId,
      person_id: person.id,
      scheduled_for: new Date(NOW),
      ...over,
    });
  }

  it("schedules the message and enqueues one job per message", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx);
    const message = await approved(ctx, account.id);
    await queueLinkedInAction(ctx, message.id);
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, message.id));
    expect(row?.status).toBe("scheduled");
    expect(row?.scheduled_for?.toISOString()).toBe(NOW);
    const jobs = ctx.enqueued("linkedin.action");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ message_id: message.id });
    expect(jobs[0]?.options).toMatchObject({ singletonKey: `linkedin.action:${message.id}` });

    await queueLinkedInAction(ctx, message.id);
    expect(ctx.enqueued("linkedin.action")).toHaveLength(1);
    // The existing job is woken so it re-reads the planned slot.
    expect(ctx.recorded.wakes).toEqual([`linkedin.slot:${message.id}`]);
  });

  it("keeps the gap between two actions planned for the same moment", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx);
    const first = await approved(ctx, account.id);
    const second = await approved(ctx, account.id);
    await queueLinkedInAction(ctx, first.id);
    await queueLinkedInAction(ctx, second.id);
    const rows = await ctx.db
      .select()
      .from(messages)
      .where(eq(messages.linkedin_account_id, account.id));
    const times = rows.map((row) => row.scheduled_for?.getTime() ?? 0).sort();
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it("moves the action to the next day when the planned day is full", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx);
    await bumpCounter(ctx.db, account.id, "2026-09-22", "invite", 15);
    const message = await approved(ctx, account.id);
    await queueLinkedInAction(ctx, message.id);
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, message.id));
    expect(row?.scheduled_for?.toISOString()).toBe("2026-09-23T14:00:00.000Z");
  });

  it("rejects drafts, non-LinkedIn messages and inactive accounts", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx);
    const draft = await approved(ctx, account.id, { status: "draft" });
    await expect(queueLinkedInAction(ctx, draft.id)).rejects.toMatchObject({ code: "conflict" });
    const email = await seedMessage(ctx, { status: "approved" });
    await expect(queueLinkedInAction(ctx, email.id)).rejects.toMatchObject({
      code: "validation_failed",
    });
    const paused = await seedLinkedInAccount(ctx, { status: "paused" });
    const onPaused = await approved(ctx, paused.id);
    await expect(queueLinkedInAction(ctx, onPaused.id)).rejects.toBeInstanceOf(OpenOutboundError);
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, onPaused.id));
    expect(row?.status).toBe("approved");
  });

  it("does not see messages of other workspaces", async () => {
    const ctx = await context();
    const other = await context();
    const account = await seedLinkedInAccount(other);
    const message = await approved(other, account.id);
    await expect(queueLinkedInAction(ctx, message.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("relations and recent posts", () => {
  it("reads relation status, defaulting to none", async () => {
    const ctx = await context();
    const account = await seedLinkedInAccount(ctx);
    const person = await seedPerson(ctx);
    expect(await getRelation(ctx, { accountId: account.id, personId: person.id })).toBe("none");
    await upsertRelation(ctx.db, {
      workspaceId: ctx.workspace.id,
      accountId: account.id,
      personId: person.id,
      status: "invited",
    });
    expect(await getRelation(ctx, { accountId: account.id, personId: person.id })).toBe("invited");
  });

  it("returns the newest post inside maxAgeDays without the raw payload", async () => {
    const provider = fakeProvider([
      { id: "old", text: "old", published_at: "2026-08-01T10:00:00Z" },
      { id: "new", text: "new", published_at: "2026-09-20T10:00:00Z", raw: { x: 1 } },
      { id: "undated", text: "?", published_at: null },
      { id: "mid", text: "mid", published_at: "2026-09-10T10:00:00Z" },
    ]);
    const ctx = await context({ providers: { linkedin: provider } });
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    const person = await seedPerson(ctx, { linkedin_url: "https://www.linkedin.com/in/dana-post" });
    const post = await getRecentPostForPerson(ctx, { accountId: account.id, personId: person.id });
    expect(post).toEqual({ id: "new", text: "new", published_at: "2026-09-20T10:00:00Z" });
    const narrow = await getRecentPostForPerson(ctx, {
      accountId: account.id,
      personId: person.id,
      maxAgeDays: 1,
    });
    expect(narrow).toBeNull();
  });

  it("returns null without calling LinkedIn for inactive accounts or missing profiles", async () => {
    const provider = fakeProvider([{ id: "p", text: "x", published_at: "2026-09-21T00:00:00Z" }]);
    const ctx = await context({ providers: { linkedin: provider } });
    const restricted = await seedLinkedInAccount(ctx, {
      provider: "unipile",
      status: "restricted",
    });
    const person = await seedPerson(ctx, { linkedin_url: "https://www.linkedin.com/in/x-post" });
    expect(
      await getRecentPostForPerson(ctx, { accountId: restricted.id, personId: person.id }),
    ).toBeNull();
    const active = await seedLinkedInAccount(ctx, { provider: "unipile" });
    const noUrl = await seedPerson(ctx);
    expect(
      await getRecentPostForPerson(ctx, { accountId: active.id, personId: noUrl.id }),
    ).toBeNull();
    expect(provider.listRecentPosts).not.toHaveBeenCalled();
  });

  it("marks the account restricted when LinkedIn reports a restriction", async () => {
    const provider = fakeProvider();
    provider.listRecentPosts.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "Account restricted", {
        details: { restricted: true },
      }),
    );
    const ctx = await context({ providers: { linkedin: provider } });
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    const person = await seedPerson(ctx, { linkedin_url: "https://www.linkedin.com/in/r-post" });
    await expect(
      getRecentPostForPerson(ctx, { accountId: account.id, personId: person.id }),
    ).rejects.toBeInstanceOf(OpenOutboundError);
    expect(ctx.emitted("linkedin.account_restricted")).toHaveLength(1);
    const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ctx.workspace.id));
    expect(ws?.status).toBe("active");
  });
});
