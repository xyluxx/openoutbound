import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import {
  type LinkedInAccount,
  linkedin_relations,
  type Message,
  messages,
  problems,
  sender_counters,
  threads,
} from "../../db/schema/index.js";
import type { LinkedInInboundMessage, LinkedInProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount, seedMessage, seedPerson } from "../../testing/factories.js";
import { runLinkedInAction } from "./action-job.js";
import { upsertRelation } from "./relations.js";
import { confirmLinkedInSent, reconcileLinkedInUnknowns } from "./unknown-actions.js";

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
  vi.clearAllMocks();
});

function fakeProvider(options: { chat?: boolean } = {}) {
  const provider = {
    id: "unipile",
    getProfile: vi.fn(async (_account: string, target: { profile_url?: string | null }) => ({
      provider_id: "ACoAAmember",
      profile_url: target.profile_url ?? "",
      connection_degree: 2 as 1 | 2 | 3 | null,
      invitation_pending: false,
    })),
    visitProfile: vi.fn(async () => {}),
    sendInvite: vi.fn(async () => ({ providerRef: "ACoAAmember" })),
    sendMessage: vi.fn(async () => ({ messageId: "msg_provider_1", chatId: "chat_1" })),
    listRecentPosts: vi.fn(async () => []),
    reactToPost: vi.fn(async () => {}),
    commentOnPost: vi.fn(async () => ({ commentId: "comment_1" })),
    syncMessages: vi.fn(
      async (): Promise<{ messages: LinkedInInboundMessage[]; cursor?: string | null }> => ({
        messages: [],
        cursor: null,
      }),
    ),
  };
  if (!options.chat) {
    const { syncMessages: _unused, ...rest } = provider;
    return rest as typeof provider;
  }
  return provider;
}

const timeout = () =>
  new OpenOutboundError("provider_error", "Unipile did not answer.", {
    details: { reason: "timeout", retryable: true },
  });

async function setup(options: { chat?: boolean } = {}) {
  const provider = fakeProvider(options);
  const ctx = await createTestContext({
    db,
    now: NOW,
    providers: { linkedin: provider as unknown as LinkedInProvider },
  });
  const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
  const person = await seedPerson(ctx, {
    full_name: "Dana Reyes",
    linkedin_url: `https://www.linkedin.com/in/dana-${Math.random().toString(36).slice(2, 8)}`,
  });
  const message = (over: Partial<Message> = {}) =>
    seedMessage(ctx, {
      channel: "linkedin",
      action: "invite",
      status: "scheduled",
      subject: null,
      body_text: "",
      linkedin_account_id: account.id,
      person_id: person.id,
      scheduled_for: new Date(NOW),
      ...over,
    });
  const reload = async (id: string) => {
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
    if (!row) throw new Error("message gone");
    return row;
  };
  const openProblems = () =>
    ctx.db.select().from(problems).where(eq(problems.workspace_id, ctx.workspace.id));
  const reconcile = () => reconcileLinkedInUnknowns(ctx.jobContext());
  return { ctx, provider, account, person, message, reload, openProblems, reconcile };
}

async function relation(ctx: TestContext, account: LinkedInAccount, personId: string) {
  const [row] = await ctx.db
    .select()
    .from(linkedin_relations)
    .where(
      and(
        eq(linkedin_relations.account_id, account.id),
        eq(linkedin_relations.person_id, personId),
      ),
    );
  return row;
}

describe("unknown LinkedIn invites", () => {
  it("become unknown on a timeout and are confirmed when LinkedIn shows the invitation", async () => {
    const s = await setup();
    s.provider.sendInvite.mockRejectedValueOnce(timeout());
    const invite = await s.message({ body_text: "Hi Dana" });
    expect(
      await runLinkedInAction(s.ctx.jobContext({ name: "linkedin.action" }), invite.id),
    ).toMatchObject({ status: "unknown" });
    expect((await s.reload(invite.id)).status).toBe("unknown");
    // Invites get no problem: the reconcile job checks the profile first.
    expect(await s.openProblems()).toHaveLength(0);

    s.provider.getProfile.mockResolvedValueOnce({
      provider_id: "ACoAAmember",
      profile_url: s.person.linkedin_url ?? "",
      connection_degree: 2,
      invitation_pending: true,
    });
    expect(await s.reconcile()).toMatchObject({ checked: 1, confirmed: 1 });
    const row = await s.reload(invite.id);
    expect(row.status).toBe("sent");
    expect(row.sent_at?.toISOString()).toBe(NOW);
    expect(await relation(s.ctx, s.account, s.person.id)).toMatchObject({
      status: "invited",
      provider_ref: "ACoAAmember",
    });
    const counters = await s.ctx.db
      .select()
      .from(sender_counters)
      .where(eq(sender_counters.sender_id, s.account.id));
    expect(counters.find((row) => row.action === "invite")?.count).toBe(1);
    expect(s.ctx.emitted("message.sent")[0]?.data).toMatchObject({
      message_id: invite.id,
      channel: "linkedin",
      action: "invite",
    });
    expect(s.provider.sendInvite).toHaveBeenCalledTimes(1);
  });

  it("are sent again once when LinkedIn shows no invitation, then go to a person", async () => {
    const s = await setup();
    const invite = await s.message({ status: "unknown" });
    for (let run = 1; run <= 2; run++) {
      expect(await s.reconcile()).toMatchObject({ pending: 1 });
    }
    expect(await s.reconcile()).toMatchObject({ resent: 1 });
    const resent = await s.reload(invite.id);
    expect(resent).toMatchObject({ status: "scheduled", reconcile_checks: 0 });
    expect(resent.why?.resent_after_unknown).toBe(NOW);
    expect(s.ctx.enqueued("linkedin.action").at(-1)?.options).toMatchObject({
      singletonKey: `linkedin.action:${invite.id}`,
    });

    // The resend is unknown again and LinkedIn still shows nothing: a person decides.
    await s.ctx.db.update(messages).set({ status: "unknown" }).where(eq(messages.id, invite.id));
    for (let run = 1; run <= 2; run++) await s.reconcile();
    expect(await s.reconcile()).toMatchObject({ problems: 1, resent: 0 });
    const [problem] = await s.openProblems();
    expect(problem).toMatchObject({
      kind: "send_unknown",
      title: "Check whether a LinkedIn invitation went out",
    });
    expect(problem?.reason).toContain("Dana Reyes");
    // Nothing is looked up again.
    expect(await s.reconcile()).toMatchObject({ checked: 0 });
  });

  it("go to a person when the profile cannot be read three times", async () => {
    const s = await setup();
    s.provider.getProfile.mockRejectedValue(new Error("gateway timeout"));
    await s.message({ status: "unknown" });
    await s.reconcile();
    await s.reconcile();
    expect(await s.reconcile()).toMatchObject({ problems: 1 });
    const [problem] = await s.openProblems();
    expect(problem?.reason).toContain("gateway timeout");
  });
});

describe("unknown LinkedIn messages and comments", () => {
  it("are confirmed by the same text in the person's own conversation when the provider can read it", async () => {
    const s = await setup({ chat: true });
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "connected",
      providerRef: "ACoAAdana",
    });
    s.provider.sendMessage.mockRejectedValueOnce(timeout());
    const message = await s.message({ action: "message", body_text: "Thanks for connecting!" });
    expect(
      await runLinkedInAction(s.ctx.jobContext({ name: "linkedin.action" }), message.id),
    ).toMatchObject({ status: "unknown" });
    expect(await s.openProblems()).toHaveLength(1);

    // No thread knows the chat yet: Dana's own answer shows which conversation is hers.
    s.provider.syncMessages?.mockResolvedValueOnce({
      messages: [
        {
          id: "li_1",
          chat_id: "chat_9",
          sender_provider_id: "me",
          text: "Thanks   for connecting!",
          sent_at: "2026-09-22T15:00:05.000Z",
          is_outbound: true,
        },
        {
          id: "li_2",
          chat_id: "chat_9",
          sender_provider_id: "ACoAAdana",
          text: "Likewise, good to connect.",
          sent_at: "2026-09-22T15:03:00.000Z",
          is_outbound: false,
        },
      ],
      cursor: null,
    });
    expect(await s.reconcile()).toMatchObject({ confirmed: 1 });
    const row = await s.reload(message.id);
    expect(row).toMatchObject({ status: "sent", provider_message_id: "li_1" });
    const [thread] = await s.ctx.db
      .select()
      .from(threads)
      .where(eq(threads.id, row.thread_id ?? ""));
    expect(thread).toMatchObject({ channel: "linkedin", external_ref: "chat_9" });
    const [problem] = await s.openProblems();
    expect(problem).toMatchObject({ status: "resolved" });
  });

  it("are never confirmed by the same text in another conversation", async () => {
    const s = await setup({ chat: true });
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "connected",
      providerRef: "ACoAAdana",
    });
    const unknown = await s.message({
      action: "message",
      status: "unknown",
      body_text: "Thanks for connecting!",
      dispatch_started_at: new Date(NOW),
    });
    // The account sent the same words to someone else; Dana's conversation is not known.
    s.provider.syncMessages?.mockResolvedValue({
      messages: [
        {
          id: "li_other",
          chat_id: "chat_77",
          sender_provider_id: "me",
          text: "Thanks for connecting!",
          sent_at: "2026-09-22T15:00:05.000Z",
          is_outbound: true,
        },
        {
          id: "li_other_answer",
          chat_id: "chat_77",
          sender_provider_id: "ACoAAsomeoneelse",
          text: "Thanks!",
          sent_at: "2026-09-22T15:02:00.000Z",
          is_outbound: false,
        },
      ],
      cursor: null,
    });
    for (let run = 1; run <= 2; run++) {
      expect(await s.reconcile()).toMatchObject({ confirmed: 0, pending: 1 });
    }
    expect(await s.reconcile()).toMatchObject({ confirmed: 0, problems: 1 });
    expect((await s.reload(unknown.id)).status).toBe("unknown");
  });

  it("stay with the problem when the text cannot be found or read", async () => {
    const withChat = await setup({ chat: true });
    const unknown = await withChat.message({
      action: "message",
      status: "unknown",
      body_text: "Hello",
    });
    for (let run = 1; run <= 2; run++) {
      expect(await withChat.reconcile()).toMatchObject({ pending: 1 });
    }
    expect(await withChat.reconcile()).toMatchObject({ problems: 1 });
    expect((await withChat.reload(unknown.id)).status).toBe("unknown");

    const noChat = await setup();
    await noChat.message({ action: "message", status: "unknown", body_text: "Hello" });
    await noChat.message({ action: "comment", status: "unknown", body_text: "Great post" });
    expect(await noChat.reconcile()).toMatchObject({ checked: 2, problems: 2 });
    expect(await noChat.openProblems()).toHaveLength(2);
    expect(await noChat.reconcile()).toMatchObject({ checked: 0 });
  });

  it("can be confirmed by a person, only while unknown", async () => {
    const s = await setup();
    const comment = await s.message({
      action: "comment",
      status: "unknown",
      body_text: "Great post",
      in_reply_to: "post_1",
    });
    expect(await confirmLinkedInSent(s.ctx, comment.id, { resolution: "Seen on LinkedIn" })).toBe(
      true,
    );
    expect((await s.reload(comment.id)).status).toBe("sent");
    expect(await confirmLinkedInSent(s.ctx, comment.id, { resolution: "again" })).toBe(false);
  });
});
