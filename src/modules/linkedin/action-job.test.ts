import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isJobWaitError, OpenOutboundError } from "../../core/errors.js";
import { providerFailure } from "../../core/failures.js";
import {
  type LinkedInAccount,
  linkedin_accounts,
  linkedin_relations,
  type Message,
  messages,
  problems,
  sender_counters,
  threads,
} from "../../db/schema/index.js";
import { createUnipileLinkedIn } from "../../providers/linkedin/unipile.js";
import { createUnipileClient } from "../../providers/linkedin/unipile-client.js";
import type { LinkedInProvider } from "../../providers/types.js";
import { notify } from "../../runtime/notify.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedLinkedInAccount,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { rescheduleUnknown } from "../email/unknown-sends.js";
import { checkContactable } from "../leads/service.js";
import { runLinkedInAction } from "./action-job.js";
import { bumpCounter } from "./capacity.js";
import { upsertRelation } from "./relations.js";

vi.mock("../leads/service.js", () => ({
  checkContactable: vi.fn(async () => ({ ok: true, reasons: [] })),
}));
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
beforeEach(() => {
  vi.mocked(checkContactable).mockClear();
  vi.mocked(notify).mockClear();
});

function fakeProvider() {
  return {
    id: "unipile",
    getProfile: vi.fn(async (_account: string, target: { profile_url?: string | null }) => ({
      provider_id: "ACoAAmember",
      profile_url: target.profile_url ?? "",
      connection_degree: 2 as 1 | 2 | 3 | null,
      invitation_pending: false,
    })),
    visitProfile: vi.fn(async () => {}),
    sendInvite: vi.fn(async (_a: string, _t: unknown, _note?: string) => ({
      providerRef: "ACoAAmember",
    })),
    sendMessage: vi.fn(
      async (
        _a: string,
        _t: unknown,
        _text: string,
        _options?: { chatId?: string },
      ): Promise<{ messageId?: string; chatId?: string }> => ({
        messageId: "msg_provider_1",
        chatId: "chat_1",
      }),
    ),
    listRecentPosts: vi.fn(
      async () => [] as Array<{ id: string; text: string; published_at: string }>,
    ),
    reactToPost: vi.fn(async () => {}),
    commentOnPost: vi.fn(async () => ({ commentId: "comment_1" })),
  } satisfies LinkedInProvider;
}

interface Setup {
  ctx: TestContext;
  provider: ReturnType<typeof fakeProvider>;
  account: LinkedInAccount;
  personId: string;
  message(over?: Partial<Message>): Promise<Message>;
  run(messageId: string): ReturnType<typeof runLinkedInAction>;
  reload(id: string): Promise<Message>;
}

async function setup(
  options: {
    now?: string;
    account?: Partial<LinkedInAccount>;
    workspace?: { status?: "paused" | "archived" };
  } = {},
): Promise<Setup> {
  const provider = fakeProvider();
  const ctx = await createTestContext({
    db,
    now: options.now ?? NOW,
    providers: { linkedin: provider },
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  const account = await seedLinkedInAccount(ctx, { provider: "unipile", ...options.account });
  const person = await seedPerson(ctx, {
    linkedin_url: `https://www.linkedin.com/in/prospect-${Math.random().toString(36).slice(2, 8)}`,
  });
  return {
    ctx,
    provider,
    account,
    personId: person.id,
    message: (over = {}) =>
      seedMessage(ctx, {
        channel: "linkedin",
        action: "invite",
        status: "scheduled",
        subject: null,
        body_text: "",
        linkedin_account_id: account.id,
        person_id: person.id,
        scheduled_for: new Date(options.now ?? NOW),
        ...over,
      }),
    run: (messageId) => runLinkedInAction(ctx.jobContext({ name: "linkedin.action" }), messageId),
    reload: async (id) => {
      const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
      if (!row) throw new Error("message gone");
      return row;
    },
  };
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
}

/** A Unipile call that got no answer, as its client reports it: the fetch error is the cause. */
function unipileNetworkError(call: string, socket: { code: string; syscall: string }) {
  const cause = Object.assign(new Error(`${socket.syscall} ${socket.code}`), socket);
  return new OpenOutboundError("provider_error", `Unipile ${call} did not answer.`, {
    details: { provider: "unipile", reason: "network", retryable: true },
    cause: new TypeError("fetch failed", { cause }),
  });
}

/** A provider call that hangs until the test lets it go on. */
interface Held<T> {
  release(): void;
  call(): Promise<T>;
}

function held<T>(result: () => T): Held<T> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    call: async () => {
      await gate;
      return result();
    },
  };
}

async function relationOf(s: Setup) {
  const [row] = await s.ctx.db
    .select()
    .from(linkedin_relations)
    .where(
      and(
        eq(linkedin_relations.account_id, s.account.id),
        eq(linkedin_relations.person_id, s.personId),
      ),
    );
  return row;
}

describe("linkedin.action: invites", () => {
  it("sends an invite with a note, records the relation, counters and event", async () => {
    const s = await setup();
    const message = await s.message({ body_text: "Saw your panel on forecast calls." });
    expect(await s.run(message.id)).toEqual({ status: "sent", message_id: message.id });
    expect(s.provider.sendInvite).toHaveBeenCalledWith(
      s.account.external_account_id,
      expect.objectContaining({ provider_id: "ACoAAmember" }),
      "Saw your panel on forecast calls.",
      // The job's signal: the call stops when the job does.
      { signal: expect.any(AbortSignal) },
    );
    const row = await s.reload(message.id);
    expect(row.status).toBe("sent");
    expect(row.sent_at?.toISOString()).toBe(NOW);
    expect(await relationOf(s)).toMatchObject({ status: "invited", provider_ref: "ACoAAmember" });
    const counters = await s.ctx.db
      .select()
      .from(sender_counters)
      .where(eq(sender_counters.sender_id, s.account.id));
    expect(counters.map((c) => [c.day, c.action, c.count]).sort()).toEqual([
      ["2026-09-22", "invite", 1],
      ["2026-09-22", "invite_note", 1],
    ]);
    expect(s.ctx.emitted("message.sent")[0]?.data).toMatchObject({
      message_id: message.id,
      channel: "linkedin",
      action: "invite",
    });
  });

  it("skips invites to people who are already connected or invited", async () => {
    const s = await setup();
    s.provider.getProfile.mockResolvedValueOnce({
      provider_id: "ACoAAmember",
      profile_url: "",
      connection_degree: 1,
      invitation_pending: false,
    });
    const first = await s.message();
    expect(await s.run(first.id)).toMatchObject({ status: "skipped", reason: "already_connected" });
    expect(await relationOf(s)).toMatchObject({ status: "connected" });
    expect(s.ctx.emitted("message.failed")[0]?.data).toEqual({
      message_id: first.id,
      error: "skipped:already_connected",
      retryable: false,
    });
    const second = await s.message();
    expect(await s.run(second.id)).toMatchObject({ reason: "already_connected" });
    expect(s.provider.getProfile).toHaveBeenCalledTimes(1);
    expect(s.provider.sendInvite).not.toHaveBeenCalled();
  });

  it("enforces note length: 200 characters free, 300 premium", async () => {
    const free = await setup();
    const long = "x".repeat(250);
    const tooLong = await free.message({ body_text: long });
    expect(await free.run(tooLong.id)).toMatchObject({ status: "failed" });
    expect((await free.reload(tooLong.id)).error).toContain("note_too_long");
    expect(free.provider.sendInvite).not.toHaveBeenCalled();

    const premium = await setup({ account: { premium: true } });
    const ok = await premium.message({ body_text: long });
    expect(await premium.run(ok.id)).toMatchObject({ status: "sent" });
  });

  it("sends without a note once the monthly note limit is used", async () => {
    const s = await setup();
    await bumpCounter(s.ctx.db, s.account.id, "2026-09-03", "invite_note", 3);
    const message = await s.message({ body_text: "Short note." });
    expect(await s.run(message.id)).toEqual({
      status: "sent",
      message_id: message.id,
      note_dropped: true,
    });
    expect(s.provider.sendInvite.mock.calls[0]?.[2]).toBeUndefined();
    expect((await s.reload(message.id)).why).toMatchObject({ note_skipped: "monthly_note_limit" });

    // Last month's notes do not count; premium accounts have no monthly cap.
    const premium = await setup({ account: { premium: true } });
    await bumpCounter(premium.ctx.db, premium.account.id, "2026-09-10", "invite_note", 12);
    const withNote = await premium.message({ body_text: "Short note." });
    await premium.run(withNote.id);
    expect(premium.provider.sendInvite.mock.calls[0]?.[2]).toBe("Short note.");
  });

  it("never re-invites within 30 days of a withdrawal", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.personId,
      status: "withdrawn",
      withdrawnAt: new Date("2026-09-12T10:00:00Z"),
    });
    const blocked = await s.message();
    const result = await s.run(blocked.id);
    expect(result).toMatchObject({ status: "skipped" });
    if (result.status === "skipped") expect(result.reason).toContain("recently_withdrawn");

    await s.ctx.db
      .update(linkedin_relations)
      .set({ withdrawn_at: new Date("2026-08-20T10:00:00Z") })
      .where(eq(linkedin_relations.account_id, s.account.id));
    const allowed = await s.message();
    expect(await s.run(allowed.id)).toMatchObject({ status: "sent" });
  });
});

describe("linkedin.action: messages, likes, comments, visits", () => {
  it("skips a message before the person is connected", async () => {
    const s = await setup();
    const message = await s.message({ action: "message", body_text: "Hi Dana" });
    expect(await s.run(message.id)).toMatchObject({ status: "skipped", reason: "not_connected" });
    expect(s.provider.sendMessage).not.toHaveBeenCalled();
  });

  it("messages a connected person and threads the chat", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.personId,
      status: "connected",
    });
    const message = await s.message({ action: "message", body_text: "Hi Dana, one question." });
    expect(await s.run(message.id)).toMatchObject({ status: "sent" });
    const row = await s.reload(message.id);
    expect(row.provider_message_id).toBe("msg_provider_1");
    const [thread] = await s.ctx.db
      .select()
      .from(threads)
      .where(eq(threads.id, row.thread_id ?? ""));
    expect(thread).toMatchObject({ channel: "linkedin", external_ref: "chat_1" });

    s.ctx.clock.advanceBy({ minutes: 15 });
    const followUp = await s.message({ action: "message", body_text: "Following up." });
    expect(await s.run(followUp.id)).toMatchObject({ status: "sent" });
    expect(s.provider.sendMessage.mock.calls[1]?.[3]).toEqual({
      chatId: "chat_1",
      signal: expect.any(AbortSignal),
    });
    expect((await s.reload(followUp.id)).thread_id).toBe(row.thread_id);
  });

  it("counts a message LinkedIn took without an id as sent, so its step never runs again", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.personId,
      status: "connected",
    });
    s.provider.sendMessage.mockResolvedValueOnce({ chatId: "chat_1" });
    const message = await s.message({ action: "message", body_text: "Hi Dana, one question." });
    expect(await s.run(message.id)).toMatchObject({ status: "sent" });
    const row = await s.reload(message.id);
    expect(row).toMatchObject({ status: "sent", provider_message_id: null });
    expect(row.sent_at).not.toBeNull();
  });

  it("skips a like without a recent post and likes the newest recent one", async () => {
    const s = await setup();
    const none = await s.message({ action: "like" });
    expect(await s.run(none.id)).toMatchObject({ status: "skipped", reason: "no_recent_post" });

    s.provider.listRecentPosts.mockResolvedValueOnce([
      { id: "urn:li:activity:old", text: "old", published_at: "2026-08-01T00:00:00Z" },
      { id: "urn:li:activity:new", text: "new", published_at: "2026-09-18T00:00:00Z" },
    ]);
    const like = await s.message({ action: "like" });
    s.ctx.clock.advanceBy({ minutes: 15 });
    expect(await s.run(like.id)).toMatchObject({ status: "sent" });
    expect(s.provider.reactToPost).toHaveBeenCalledWith(
      s.account.external_account_id,
      "urn:li:activity:new",
      "like",
      { signal: expect.any(AbortSignal) },
    );
    expect((await s.reload(like.id)).in_reply_to).toBe("urn:li:activity:new");
  });

  it("comments on the post the comment was written for", async () => {
    const s = await setup();
    const comment = await s.message({
      action: "comment",
      body_text: "Useful point about reorder cadence.",
      in_reply_to: "urn:li:activity:42",
    });
    expect(await s.run(comment.id)).toMatchObject({ status: "sent" });
    expect(s.provider.commentOnPost).toHaveBeenCalledWith(
      s.account.external_account_id,
      "urn:li:activity:42",
      "Useful point about reorder cadence.",
      { signal: expect.any(AbortSignal) },
    );
    expect(s.provider.listRecentPosts).not.toHaveBeenCalled();
    expect((await s.reload(comment.id)).provider_message_id).toBe("comment_1");
  });

  it("visits profiles", async () => {
    const s = await setup();
    const visit = await s.message({ action: "visit" });
    expect(await s.run(visit.id)).toMatchObject({ status: "sent" });
    expect(s.provider.visitProfile).toHaveBeenCalledTimes(1);
  });

  it("skips people that are not contactable (suppressed)", async () => {
    const s = await setup();
    vi.mocked(checkContactable).mockResolvedValueOnce({
      ok: false,
      reasons: ["suppressed_linkedin"],
    });
    const message = await s.message({ action: "visit" });
    expect(await s.run(message.id)).toMatchObject({
      status: "skipped",
      reason: "not_contactable:suppressed_linkedin",
    });
    expect(checkContactable).toHaveBeenCalledWith(expect.anything(), {
      personId: s.personId,
      channel: "linkedin",
    });
    expect(s.provider.visitProfile).not.toHaveBeenCalled();
  });

  it("answers a conversation at a held company but holds back campaign steps", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.personId,
      status: "connected",
    });
    const held = { ok: false, reasons: ["company_on_hold", "company_open_deal"] };
    vi.mocked(checkContactable).mockResolvedValueOnce(held);
    // A reply from the inbox has no campaign step.
    const reply = await s.message({ action: "message", body_text: "Thanks, happy to help." });
    expect(await s.run(reply.id)).toMatchObject({ status: "sent" });

    s.ctx.clock.advanceBy({ minutes: 15 });
    vi.mocked(checkContactable).mockResolvedValueOnce(held);
    const step = await s.message({
      action: "message",
      body_text: "Following up.",
      step_id: "stp_x",
    });
    expect(await s.run(step.id)).toMatchObject({
      status: "skipped",
      reason: "not_contactable:company_on_hold,company_open_deal",
    });

    // Opt-outs still stop a conversation answer.
    vi.mocked(checkContactable).mockResolvedValueOnce({
      ok: false,
      reasons: ["company_on_hold", "suppressed_person"],
    });
    const optedOut = await s.message({ action: "message", body_text: "One more thing." });
    expect(await s.run(optedOut.id)).toMatchObject({
      status: "skipped",
      reason: "not_contactable:suppressed_person",
    });
    expect(s.provider.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("linkedin.action: safety re-checks", () => {
  it("parks while the workspace is paused (kill switch)", async () => {
    const s = await setup({ workspace: { status: "paused" } });
    const message = await s.message({ action: "visit" });
    const error = await s.run(message.id).catch((e: unknown) => e);
    expect(isJobWaitError(error)).toBe(true);
    expect((await s.reload(message.id)).status).toBe("scheduled");
    expect(s.provider.visitProfile).not.toHaveBeenCalled();
  });

  it("returns actions of an archived workspace to approved", async () => {
    const s = await setup({ workspace: { status: "archived" } });
    const message = await s.message({ action: "visit" });
    expect(await s.run(message.id)).toMatchObject({
      status: "paused",
      reason: "workspace archived",
    });
    expect((await s.reload(message.id)).status).toBe("approved");
    expect(s.provider.visitProfile).not.toHaveBeenCalled();
  });

  it("waits for the planned slot when an older job wakes up early", async () => {
    const s = await setup();
    const message = await s.message({
      action: "visit",
      scheduled_for: new Date("2026-09-22T16:30:00Z"),
    });
    const error = await s.run(message.id).catch((e: unknown) => e);
    expect(isJobWaitError(error) && error.retryAt?.toISOString()).toBe("2026-09-22T16:30:00.000Z");
    expect((await s.reload(message.id)).status).toBe("scheduled");
    expect(s.provider.visitProfile).not.toHaveBeenCalled();
  });

  it("puts the action back to approved when the account is paused", async () => {
    const s = await setup({ account: { status: "paused" } });
    const message = await s.message({ action: "visit" });
    expect(await s.run(message.id)).toMatchObject({ status: "paused" });
    expect((await s.reload(message.id)).status).toBe("approved");
  });

  it("reschedules when run outside working hours", async () => {
    const s = await setup({ now: "2026-09-19T12:00:00.000Z" });
    const message = await s.message({ action: "visit" });
    const error = await s.run(message.id).catch((e: unknown) => e);
    expect(isJobWaitError(error) && error.retryAt?.toISOString()).toBe("2026-09-21T14:00:00.000Z");
    expect((await s.reload(message.id)).scheduled_for?.toISOString()).toBe(
      "2026-09-21T14:00:00.000Z",
    );
  });

  it("keeps at least 2 minutes after an action that just ran", async () => {
    const s = await setup();
    await s.message({ action: "visit", status: "sent", sent_at: new Date("2026-09-22T14:59:30Z") });
    const message = await s.message({ action: "visit" });
    const error = await s.run(message.id).catch((e: unknown) => e);
    expect(isJobWaitError(error)).toBe(true);
    if (isJobWaitError(error)) {
      expect(error.retryAt?.getTime()).toBeGreaterThanOrEqual(
        new Date("2026-09-22T15:01:30Z").getTime(),
      );
    }
  });

  it("does nothing for messages already sent or cancelled", async () => {
    const s = await setup();
    const sent = await s.message({ action: "visit", status: "sent" });
    expect(await s.run(sent.id)).toMatchObject({ status: "skipped", reason: "status_sent" });
    const cancelled = await s.message({ action: "visit", status: "cancelled" });
    expect(await s.run(cancelled.id)).toMatchObject({ reason: "status_cancelled" });
    expect(s.provider.visitProfile).not.toHaveBeenCalled();
  });

  it("never repeats an action interrupted mid-flight: text becomes unknown, visits run again", async () => {
    const s = await setup();
    const stuck = await s.message({ action: "message", status: "sending", body_text: "Hi" });
    expect(await s.run(stuck.id)).toEqual({
      status: "unknown",
      message_id: stuck.id,
      reason: "the previous attempt stopped while sending",
    });
    expect(s.provider.sendMessage).not.toHaveBeenCalled();
    expect((await s.reload(stuck.id)).status).toBe("unknown");
    expect(s.ctx.emitted("message.unknown")[0]?.data).toMatchObject({
      message_id: stuck.id,
      channel: "linkedin",
    });
    const [problem] = await s.ctx.db
      .select()
      .from(problems)
      .where(eq(problems.workspace_id, s.ctx.workspace.id));
    expect(problem).toMatchObject({
      kind: "send_unknown",
      title: "Check whether a LinkedIn message went out",
      dedupe_key: `send_unknown:${stuck.id}`,
    });
    expect(problem?.remedy).toContain("Check the conversation on LinkedIn before sending again");

    // An invite waits for the reconcile job (no problem yet).
    const invite = await s.message({ action: "invite", status: "sending" });
    expect(await s.run(invite.id)).toMatchObject({ status: "unknown" });
    const open = await s.ctx.db
      .select()
      .from(problems)
      .where(eq(problems.workspace_id, s.ctx.workspace.id));
    expect(open).toHaveLength(1);

    // A visit is harmless to repeat (at least once by design): the same job runs it again.
    s.ctx.clock.advanceBy({ minutes: 15 });
    const visit = await s.message({ action: "visit", status: "sending", attempt: 1 });
    expect(await s.run(visit.id)).toEqual({ status: "sent", message_id: visit.id });
    expect(await s.reload(visit.id)).toMatchObject({ status: "sent", attempt: 2 });
    expect(s.provider.visitProfile).toHaveBeenCalledTimes(1);
  });

  it("fails a visit for good after it stopped mid-action three times", async () => {
    const s = await setup();
    const visit = await s.message({ action: "visit", status: "sending", attempt: 3 });
    expect(await s.run(visit.id)).toMatchObject({ status: "failed" });
    const row = await s.reload(visit.id);
    expect(row).toMatchObject({ status: "failed" });
    // It may have happened (visits are done at least once): not a failure before handover.
    expect(row.why?.failed_before_handover).toBe(false);
    expect(s.provider.visitProfile).not.toHaveBeenCalled();
  });
});

describe("linkedin.action: provider failures", () => {
  it("restricts the account, pauses its queue, emits and notifies", async () => {
    const s = await setup();
    s.provider.visitProfile.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "Checkpoint required", {
        details: { restricted: true },
      }),
    );
    const queued = await s.message({
      action: "invite",
      scheduled_for: new Date("2026-09-22T16:00:00Z"),
    });
    const message = await s.message({ action: "visit" });
    expect(await s.run(message.id)).toMatchObject({ status: "paused" });
    const [account] = await s.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, s.account.id));
    expect(account?.status).toBe("restricted");
    expect((await s.reload(queued.id)).status).toBe("approved");
    expect((await s.reload(message.id)).status).toBe("approved");
    expect(s.ctx.emitted("linkedin.account_restricted")[0]?.data.account_id).toBe(s.account.id);
    expect(notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: "critical", event: "linkedin.account_restricted" }),
    );
  });

  it("backs off on a rate limit and restricts after three in a row", async () => {
    const s = await setup();
    const rateLimit = () =>
      new OpenOutboundError("provider_error", "Too many requests", {
        details: { rateLimited: true },
        retryAfterSeconds: 3600,
      });
    for (let attempt = 1; attempt <= 2; attempt++) {
      s.provider.visitProfile.mockRejectedValueOnce(rateLimit());
      const message = await s.message({ action: "visit" });
      const error = await s.run(message.id).catch((e: unknown) => e);
      expect(isJobWaitError(error)).toBe(true);
      const row = await s.reload(message.id);
      expect(row.status).toBe("scheduled");
      expect(row.scheduled_for?.getTime()).toBeGreaterThanOrEqual(
        new Date("2026-09-22T16:00:00Z").getTime(),
      );
      await s.ctx.db
        .update(messages)
        .set({ status: "cancelled" })
        .where(eq(messages.id, message.id));
      s.ctx.clock.advanceBy({ minutes: 15 });
    }
    s.provider.visitProfile.mockRejectedValueOnce(rateLimit());
    const third = await s.message({ action: "visit" });
    expect(await s.run(third.id)).toMatchObject({ status: "paused" });
    expect(s.ctx.emitted("linkedin.account_restricted")).toHaveLength(1);
  });

  it("waits instead of failing while the provider is paused for the workspace", async () => {
    const s = await setup();
    const paused = providerFailure({
      provider: "unipile",
      name: "Unipile",
      class: "auth_invalid",
      scope: "account",
      retryable: false,
      details: { paused: true },
    });
    s.provider.sendInvite.mockRejectedValueOnce(paused);
    const message = await s.message({ action: "invite" });
    const error = await s.run(message.id).catch((e: unknown) => e);
    expect(isJobWaitError(error)).toBe(true);
    const row = await s.reload(message.id);
    expect(row.status).toBe("scheduled");
    expect(row.error).toMatch(/^provider_paused: /);
    expect(row.scheduled_for?.getTime()).toBeGreaterThanOrEqual(
      s.ctx.clock.now().getTime() + 15 * 60_000,
    );
    const [account] = await s.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, s.account.id));
    expect(account?.status).toBe("active");
    expect(s.ctx.emitted("message.failed")).toHaveLength(0);

    // A used-up quota of the provider account waits as long as the provider says.
    const quota = providerFailure({
      provider: "unipile",
      name: "Unipile",
      class: "quota_exhausted",
      retryAfterSeconds: 7200,
    });
    s.provider.visitProfile.mockRejectedValueOnce(quota);
    const visit = await s.message({ action: "visit" });
    expect(isJobWaitError(await s.run(visit.id).catch((e: unknown) => e))).toBe(true);
    const waited = await s.reload(visit.id);
    expect(waited.status).toBe("scheduled");
    expect(waited.scheduled_for?.getTime()).toBeGreaterThanOrEqual(
      s.ctx.clock.now().getTime() + 7200 * 1000,
    );
  });

  it("waits instead of failing when the account's provider was removed", async () => {
    const s = await setup();
    const visit = await s.message({ action: "visit" });
    const get = vi
      .spyOn(s.ctx.providers, "get")
      .mockRejectedValue(
        new OpenOutboundError("provider_not_configured", "No linkedin provider is configured."),
      );
    try {
      for (let run = 0; run < 4; run++) {
        expect(isJobWaitError(await s.run(visit.id).catch((e: unknown) => e))).toBe(true);
      }
    } finally {
      get.mockRestore();
    }
    const row = await s.reload(visit.id);
    expect(row.status).toBe("scheduled");
    expect(s.provider.visitProfile).not.toHaveBeenCalled();
    expect(s.ctx.emitted("message.failed")).toHaveLength(0);

    // A provider set again: the visit goes out.
    expect(await s.run(visit.id)).toMatchObject({ status: "sent" });
    expect(s.provider.visitProfile).toHaveBeenCalledTimes(1);
  });

  it("marks the account disconnected when the session is gone", async () => {
    const s = await setup();
    s.provider.visitProfile.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "disconnected", { details: { disconnected: true } }),
    );
    const message = await s.message({ action: "visit" });
    expect(await s.run(message.id)).toMatchObject({ status: "paused" });
    const [account] = await s.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, s.account.id));
    expect(account?.status).toBe("disconnected");
    expect(s.ctx.emitted("linkedin.account_restricted")).toHaveLength(0);
  });

  it("never resends a message whose delivery is uncertain", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.personId,
      status: "connected",
    });
    s.provider.sendMessage.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "Unipile POST /chats did not answer.", {
        details: { reason: "timeout", retryable: true },
      }),
    );
    const message = await s.message({ action: "message", body_text: "Thanks for connecting." });
    expect(await s.run(message.id)).toMatchObject({ status: "unknown" });
    const row = await s.reload(message.id);
    expect(row.status).toBe("unknown");
    expect(row.dispatch_started_at?.toISOString()).toBe(NOW);
    expect(row.error).toContain("no clear answer from LinkedIn");
    expect(s.ctx.emitted("message.failed")).toHaveLength(0);
    const [problem] = await s.ctx.db
      .select()
      .from(problems)
      .where(eq(problems.workspace_id, s.ctx.workspace.id));
    expect(problem).toMatchObject({ kind: "send_unknown", severity: "high", owner: "person" });

    // A server error may come after LinkedIn acted: unknown as well, never retried.
    s.ctx.clock.advanceBy({ minutes: 15 });
    s.provider.sendMessage.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "Unipile POST /chats failed (503)", {
        details: { provider: "unipile", status: 503, retryable: true },
      }),
    );
    const second = await s.message({ action: "message", body_text: "Following up." });
    expect(await s.run(second.id)).toMatchObject({ status: "unknown" });
    expect((await s.reload(second.id)).status).toBe("unknown");
    expect(s.provider.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("retries only an invite, message or comment that never reached LinkedIn", async () => {
    // The connection to Unipile was refused: the invite was never sent, so it is tried again.
    const refused = await setup();
    refused.provider.sendInvite.mockRejectedValueOnce(
      unipileNetworkError("POST /users/invite", { code: "ECONNREFUSED", syscall: "connect" }),
    );
    const invite = await refused.message();
    await expect(refused.run(invite.id)).rejects.toBeInstanceOf(OpenOutboundError);
    expect((await refused.reload(invite.id)).status).toBe("scheduled");

    // Reading the posts before a comment failed: the comment itself was never sent.
    const reading = await setup();
    reading.provider.listRecentPosts.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "Unipile GET /users/:id/posts failed (503)", {
        details: { provider: "unipile", status: 503, retryable: true },
      }),
    );
    const comment = await reading.message({ action: "comment", body_text: "Well put." });
    await expect(reading.run(comment.id)).rejects.toBeInstanceOf(OpenOutboundError);
    expect((await reading.reload(comment.id)).status).toBe("scheduled");
    expect(reading.provider.commentOnPost).not.toHaveBeenCalled();

    // A connection that dropped once the request was out may have acted: never retried.
    const dropped = await setup();
    await upsertRelation(dropped.ctx.db, {
      workspaceId: dropped.ctx.workspace.id,
      accountId: dropped.account.id,
      personId: dropped.personId,
      status: "connected",
    });
    dropped.provider.sendMessage.mockRejectedValueOnce(
      unipileNetworkError("POST /chats", { code: "ECONNRESET", syscall: "read" }),
    );
    const message = await dropped.message({ action: "message", body_text: "Thanks." });
    expect(await dropped.run(message.id)).toMatchObject({ status: "unknown" });
    expect((await dropped.reload(message.id)).status).toBe("unknown");
  });

  it("fails permanent errors and retries transient ones until the last attempt", async () => {
    const s = await setup();
    s.provider.visitProfile.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "Not found", { details: { retryable: false } }),
    );
    const permanent = await s.message({ action: "visit" });
    expect(await s.run(permanent.id)).toMatchObject({ status: "failed" });
    expect(s.ctx.emitted("message.failed")[0]?.data.retryable).toBe(false);

    s.ctx.clock.advanceBy({ minutes: 15 });
    s.provider.visitProfile.mockRejectedValue(
      new OpenOutboundError("provider_error", "Bad gateway", { details: { retryable: true } }),
    );
    const transient = await s.message({ action: "visit" });
    await expect(s.run(transient.id)).rejects.toBeInstanceOf(OpenOutboundError);
    expect((await s.reload(transient.id)).status).toBe("scheduled");
    const last = await runLinkedInAction(
      s.ctx.jobContext({ name: "linkedin.action", attempt: 5, maxAttempts: 5 }),
      transient.id,
    );
    expect(last).toMatchObject({ status: "failed" });
    // A visit that kept failing may have happened: it never counts as failed before handover.
    expect((await s.reload(transient.id)).why?.failed_before_handover).toBe(false);
    expect((await s.reload(permanent.id)).why?.failed_before_handover).toBe(true);
  });
});

describe("linkedin.action: an invite that reached LinkedIn, by failure class", () => {
  it.each([
    ["timeout", "call", "unknown"],
    ["network", "call", "unknown"],
    ["unavailable", "provider", "unknown"],
    ["malformed", "call", "unknown"],
    ["outcome_unknown", "call", "unknown"],
    ["rate_limited", "account", "later"],
    // The provider's own key, quota or access (provider health pauses it): wait for the fix.
    ["quota_exhausted", "account", "later"],
    ["auth_invalid", "account", "later"],
    ["forbidden", "account", "later"],
    // A refusal of this one action: it did not go out.
    ["quota_exhausted", "call", "failed"],
    ["forbidden", "call", "failed"],
    ["not_found", "call", "failed"],
    ["bad_request", "call", "failed"],
    ["refused", "call", "failed"],
  ] as const)("%s (scope %s) leaves it %s", async (failureClass, scope, expected) => {
    const s = await setup();
    s.provider.sendInvite.mockRejectedValueOnce(
      providerFailure({ class: failureClass, scope, provider: "unipile", name: "Unipile" }),
    );
    const message = await s.message({ body_text: "Glad to connect." });
    const outcome = await s.run(message.id).catch((error: unknown) => error);
    const row = await s.reload(message.id);
    if (expected === "unknown") {
      // It may have gone out: never failed, never retried on its own.
      expect(outcome).toMatchObject({ status: "unknown" });
      expect(row.status).toBe("unknown");
    } else if (expected === "later") {
      // LinkedIn refused it for now: the same message is tried again later (a later slot, or
      // the job's retry), nothing went out.
      expect(isJobWaitError(outcome) || outcome instanceof OpenOutboundError).toBe(true);
      expect(row.status).toBe("scheduled");
    } else {
      // LinkedIn refused it: it did not go out.
      expect(outcome).toMatchObject({ status: "failed" });
      expect(row).toMatchObject({ status: "failed" });
      expect(row.why?.failed_before_handover).toBe(true);
    }
    expect(s.provider.sendInvite).toHaveBeenCalledTimes(1);
  });
});

describe("linkedin.action: the real Unipile provider behind a fake fetch", () => {
  /** A connected person with a known chat, and the Unipile provider answering through `answer`. */
  async function realUnipile(answer: (url: string, init?: RequestInit) => Promise<Response>) {
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return answer(url, init);
    }) as typeof globalThis.fetch;
    const ctx = await createTestContext({ db, now: NOW });
    const provider = createUnipileLinkedIn(
      createUnipileClient({
        dsn: "api1.unipile.example.com:13111",
        apiKey: "test-key",
        fetch,
        timeoutMs: 5_000,
      }),
      ctx.clock,
    );
    const scoped = await createTestContext({
      db,
      now: NOW,
      providers: { linkedin: provider },
    });
    const account = await seedLinkedInAccount(scoped, { provider: "unipile" });
    const person = await seedPerson(scoped, {
      linkedin_url: `https://www.linkedin.com/in/real-${Math.random().toString(36).slice(2, 8)}`,
    });
    await upsertRelation(scoped.db, {
      workspaceId: scoped.workspace.id,
      accountId: account.id,
      personId: person.id,
      status: "connected",
      providerRef: "ACoAAreal",
    });
    await seedThread(scoped, {
      channel: "linkedin",
      linkedin_account_id: account.id,
      person_id: person.id,
      external_ref: "chat_real",
    });
    const message = await seedMessage(scoped, {
      channel: "linkedin",
      action: "message",
      status: "scheduled",
      subject: null,
      body_text: "Thanks for the intro.",
      linkedin_account_id: account.id,
      person_id: person.id,
      scheduled_for: new Date(NOW),
    });
    const outcome = await runLinkedInAction(
      scoped.jobContext({ name: "linkedin.action" }),
      message.id,
    ).catch((error: unknown) => error);
    const [row] = await scoped.db.select().from(messages).where(eq(messages.id, message.id));
    return { outcome, row, calls };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("records a server error after the request as unknown", async () => {
    const { outcome, row, calls } = await realUnipile(async () =>
      json(503, { type: "errors/service_unavailable", title: "Unavailable" }),
    );
    expect(outcome).toMatchObject({ status: "unknown" });
    expect(row?.status).toBe("unknown");
    expect(calls).toEqual(["POST /api/v1/chats/chat_real/messages"]);
  });

  it("fails a message LinkedIn refused, before anything went out", async () => {
    const { outcome, row } = await realUnipile(async () =>
      json(422, { type: "errors/invalid_parameters", title: "Invalid parameters" }),
    );
    expect(outcome).toMatchObject({ status: "failed" });
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.why?.failed_before_handover).toBe(true);
  });

  it("retries a message whose connection never opened", async () => {
    const { outcome, row } = await realUnipile(async () => {
      const socket = Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
        syscall: "connect",
      });
      throw new TypeError("fetch failed", { cause: socket });
    });
    expect(outcome).toBeInstanceOf(OpenOutboundError);
    expect(row).toMatchObject({ status: "scheduled", attempt: 1 });
  });

  it("counts a message as sent when the answer has no id", async () => {
    const { outcome, row } = await realUnipile(async () => json(201, { object: "MessageSent" }));
    expect(outcome).toMatchObject({ status: "sent" });
    expect(row).toMatchObject({ status: "sent", provider_message_id: null });
  });

  it("records an unreadable answer as unknown, never failed", async () => {
    const { outcome, row } = await realUnipile(
      async () => new Response("<html>gateway</html>", { status: 200 }),
    );
    expect(outcome).toMatchObject({ status: "unknown" });
    expect(row?.status).toBe("unknown");
  });
});

describe("linkedin.action: writes only while the message is still held", () => {
  /**
   * The first invite hangs; the job's retry finds it `sending` and marks it unknown, and it is
   * sent again (a second attempt claims it) before the first call comes back.
   */
  async function resentWhileTheFirstHangs(s: Setup, first: Held<{ providerRef: string }>) {
    const message = await s.message();
    const second = held(() => ({ providerRef: "ACoAAmember" }));
    s.provider.sendInvite.mockImplementationOnce(first.call).mockImplementationOnce(second.call);
    const firstRun = s.run(message.id);
    await waitUntil(() => s.provider.sendInvite.mock.calls.length === 1);
    expect(await s.run(message.id)).toMatchObject({ status: "unknown" });
    expect(await rescheduleUnknown(s.ctx, await s.reload(message.id), "no invitation")).toBe(true);
    const resend = s.run(message.id);
    await waitUntil(() => s.provider.sendInvite.mock.calls.length === 2);
    expect(await s.reload(message.id)).toMatchObject({ status: "sending", attempt: 2 });
    return { message, second, firstRun, resend };
  }

  it("records a duplicate when an earlier attempt's late success comes back on a resend's claim", async () => {
    const s = await setup();
    const first = held(() => ({ providerRef: "ACoAAmember" }));
    const { message, second, firstRun, resend } = await resentWhileTheFirstHangs(s, first);

    // The first attempt's success never counts as the resend's result, but it is remembered.
    first.release();
    expect(await firstRun).toEqual({
      status: "skipped",
      message_id: message.id,
      reason: "newer_attempt_sending",
    });
    expect(await s.reload(message.id)).toMatchObject({
      status: "sending",
      why: expect.objectContaining({ earlier_attempt_went_out: 1 }),
    });
    // The resend went out too: sent once, and the second copy recorded as a duplicate.
    second.release();
    expect(await resend).toEqual({ status: "sent", message_id: message.id });
    const row = await s.reload(message.id);
    expect(row).toMatchObject({ status: "sent", attempt: 2 });
    expect(row.why?.duplicate_attempts).toEqual([1, 2]);
    expect(s.ctx.emitted("message.sent")).toHaveLength(1);
    expect(s.ctx.emitted("message.duplicate").map((event) => event.data)).toEqual([
      expect.objectContaining({ message_id: message.id, attempts: [1, 2], channel: "linkedin" }),
    ]);
    const duplicate = (await s.ctx.db.select().from(problems)).find(
      (problem) => problem.kind === "duplicate_send" && problem.subject_id === message.id,
    );
    expect(duplicate).toMatchObject({
      status: "open",
      title: "LinkedIn invitation went out twice",
    });
  });

  it("never puts a resend back in the queue when an earlier attempt fails late", async () => {
    const s = await setup();
    const first = held((): { providerRef: string } => {
      throw new OpenOutboundError("provider_error", "Too many requests", {
        details: { rateLimited: true },
        retryAfterSeconds: 3600,
      });
    });
    const { message, second, firstRun, resend } = await resentWhileTheFirstHangs(s, first);

    first.release();
    expect(await firstRun).toEqual({
      status: "skipped",
      message_id: message.id,
      reason: "status_changed",
    });
    expect(await s.reload(message.id)).toMatchObject({ status: "sending", attempt: 2 });
    second.release();
    expect(await resend).toEqual({ status: "sent", message_id: message.id });
    expect((await s.reload(message.id)).status).toBe("sent");
    expect(s.provider.sendInvite).toHaveBeenCalledTimes(2);
  });

  it("leaves an action cancelled when it is cancelled while its checks run", async () => {
    const s = await setup();
    const message = await s.message({ action: "visit" });
    vi.mocked(checkContactable).mockImplementationOnce(async () => {
      await s.ctx.db
        .update(messages)
        .set({ status: "cancelled", error: "enrollment_stopped:replied" })
        .where(eq(messages.id, message.id));
      return { ok: false, reasons: ["suppressed_linkedin"] };
    });
    expect(await s.run(message.id)).toEqual({
      status: "skipped",
      message_id: message.id,
      reason: "status_changed",
    });
    expect(await s.reload(message.id)).toMatchObject({
      status: "cancelled",
      error: "enrollment_stopped:replied",
    });
    expect(s.ctx.emitted("message.failed")).toHaveLength(0);
  });
});
