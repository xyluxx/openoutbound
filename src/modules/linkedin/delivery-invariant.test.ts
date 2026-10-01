/**
 * The delivery invariant (docs/concepts/delivery-guarantees.md) at the LinkedIn boundaries:
 * B3 invitation, B4 message, B5 comment, one test per scenario. The table on that page names
 * these tests by title, and tests/delivery-invariant-doc.test.ts checks that they exist.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import {
  approvals,
  type LinkedInAccount,
  linkedin_accounts,
  type Message,
  messages,
  type Person,
  problems,
} from "../../db/schema/index.js";
import { createUnipileClient } from "../../providers/linkedin/unipile-client.js";
import type { LinkedInProvider, ProviderCallOptions } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount, seedMessage, seedPerson } from "../../testing/factories.js";
import { resolveUnknownOperation } from "../email/unknown-operations.js";
import { type ActionJobResult, runLinkedInAction } from "./action-job.js";
import { findRelation, upsertRelation } from "./relations.js";
import { reconcileLinkedInUnknowns } from "./unknown-actions.js";

vi.mock("../leads/service.js", () => ({
  checkContactable: vi.fn(async () => ({ ok: true, reasons: [] })),
}));
vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

/** Tuesday 2026-09-22 10:00 in Chicago, inside the account's working hours. */
const NOW = "2026-09-22T15:00:00.000Z";
const POST = "urn:li:activity:7001";

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

type Write = "sendInvite" | "sendMessage" | "commentOnPost";

/** A LinkedIn provider whose calls the tests steer. */
function fakeProvider() {
  return {
    id: "unipile",
    getProfile: vi.fn(async (_account: string, target: { profile_url?: string | null }) => ({
      provider_id: "ACoAAdana",
      profile_url: target.profile_url ?? "",
      connection_degree: 2 as 1 | 2 | 3 | null,
      invitation_pending: false,
    })),
    visitProfile: vi.fn(async () => {}),
    sendInvite: vi.fn(
      async (
        _account: string,
        _target: unknown,
        _note?: string,
        _options?: ProviderCallOptions,
      ): Promise<{ providerRef?: string }> => ({ providerRef: "ACoAAdana" }),
    ),
    sendMessage: vi.fn(
      async (
        _account: string,
        _target: unknown,
        _text: string,
        _options?: { chatId?: string } & ProviderCallOptions,
      ): Promise<{ messageId?: string; chatId?: string }> => ({
        messageId: "li_msg_1",
        chatId: "chat_dana",
      }),
    ),
    listRecentPosts: vi.fn(async () => [
      { id: POST, text: "We opened a second clinic", published_at: "2026-09-20T12:00:00Z" },
    ]),
    reactToPost: vi.fn(async () => {}),
    commentOnPost: vi.fn(
      async (
        _account: string,
        _postId: string,
        _text: string,
        _options?: ProviderCallOptions,
      ): Promise<{ commentId?: string }> => ({ commentId: "li_comment_1" }),
    ),
  } satisfies LinkedInProvider;
}

type Provider = ReturnType<typeof fakeProvider>;
type ProblemKind = (typeof problems.$inferSelect)["kind"];

interface World {
  ctx: TestContext;
  provider: Provider;
  account: LinkedInAccount;
  person: Person;
  /** A scheduled action of this kind, due now. */
  action(kind: "invite" | "message" | "comment", over?: Partial<Message>): Promise<Message>;
  run(messageId: string, signal?: AbortSignal): Promise<ActionJobResult>;
  reload(id: string): Promise<Message>;
  openProblems(kind: ProblemKind): Promise<Array<typeof problems.$inferSelect>>;
}

const WRITE: Record<"invite" | "message" | "comment", Write> = {
  invite: "sendInvite",
  message: "sendMessage",
  comment: "commentOnPost",
};

const TEXT: Record<"invite" | "message" | "comment", string> = {
  invite: "",
  message: "Thanks for connecting, Dana.",
  comment: "Congratulations on the second clinic.",
};

/** An account and Dana; for messages and comments she is connected, for invitations not yet. */
async function world(kind: "invite" | "message" | "comment" = "message"): Promise<World> {
  const provider = fakeProvider();
  const ctx = await createTestContext({ db, now: NOW, providers: { linkedin: provider } });
  const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
  const person = await seedPerson(ctx, {
    full_name: "Dana Reyes",
    linkedin_url: `https://www.linkedin.com/in/dana-${Math.random().toString(36).slice(2, 8)}`,
  });
  await upsertRelation(ctx.db, {
    workspaceId: ctx.workspace.id,
    accountId: account.id,
    personId: person.id,
    status: kind === "invite" ? "none" : "connected",
    providerRef: "ACoAAdana",
  });
  return {
    ctx,
    provider,
    account,
    person,
    action: (kind, over = {}) =>
      seedMessage(ctx, {
        channel: "linkedin",
        action: kind,
        status: "scheduled",
        subject: null,
        body_text: TEXT[kind],
        in_reply_to: kind === "comment" ? POST : null,
        linkedin_account_id: account.id,
        person_id: person.id,
        scheduled_for: new Date(NOW),
        ...over,
      }),
    run: (messageId, signal) =>
      runLinkedInAction(
        ctx.jobContext({ name: "linkedin.action", ...(signal ? { signal } : {}) }),
        messageId,
      ),
    reload: async (id) => {
      const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
      if (!row) throw new Error("message gone");
      return row;
    },
    openProblems: (kind) =>
      ctx.db
        .select()
        .from(problems)
        .where(
          and(
            eq(problems.workspace_id, ctx.workspace.id),
            eq(problems.kind, kind),
            eq(problems.status, "open"),
          ),
        ),
  };
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
}

/** A provider call that waits until the test lets it answer. */
function heldCall<T>(answer: () => T) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    call: async () => {
      await gate;
      return answer();
    },
  };
}

/** A Unipile call whose connection was cut once the request was out. */
function droppedConnection(call: string) {
  const socket = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    syscall: "read",
  });
  return new OpenOutboundError("provider_error", `Unipile ${call} did not answer.`, {
    details: { provider: "unipile", reason: "network", retryable: true },
    cause: new TypeError("fetch failed", { cause: socket }),
  });
}

/** A Unipile call whose connection never opened: nothing was sent. */
function refusedConnection(call: string) {
  const socket = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
    syscall: "connect",
  });
  return new OpenOutboundError("provider_error", `Unipile ${call} did not answer.`, {
    details: { provider: "unipile", reason: "network", retryable: true },
    cause: new TypeError("fetch failed", { cause: socket }),
  });
}

/** The error the real Unipile client gives when sending a message gets `answer`. */
async function unipileFailure(
  answer: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Error> {
  const client = createUnipileClient({
    dsn: "api1.unipile.example.com:13111",
    apiKey: "example-unipile-key",
    fetch: answer as unknown as typeof globalThis.fetch,
  });
  return client.request("POST", "/chats", { write: true, json: { text: "Hi Dana" }, signal }).then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: Error) => error,
  );
}

/** A connection that timed out while opening: nothing was sent. */
async function connectTimeout(): Promise<Response> {
  const cause = Object.assign(new Error("Connect Timeout Error"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  throw new TypeError("fetch failed", { cause });
}

const timeout = (call: string) =>
  new OpenOutboundError("provider_error", `Unipile ${call} did not answer.`, {
    details: { provider: "unipile", reason: "timeout", retryable: true },
  });

const serverError = (call: string) =>
  new OpenOutboundError("provider_error", `Unipile ${call} failed (503)`, {
    details: { provider: "unipile", status: 503, retryable: true },
  });

/** S1: a message row found `sending` (its worker died mid-send) becomes unknown, no handover. */
async function foundMidSend(kind: "invite" | "message" | "comment") {
  const w = await world(kind);
  const stuck = await w.action(kind, {
    status: "sending",
    attempt: 1,
    dispatch_started_at: new Date(NOW),
  });
  expect(await w.run(stuck.id)).toMatchObject({ status: "unknown" });
  expect(await w.reload(stuck.id)).toMatchObject({ status: "unknown", attempt: 1 });
  expect(w.provider[WRITE[kind]]).not.toHaveBeenCalled();
  expect(w.ctx.emitted("message.unknown").map((event) => event.data.message_id)).toEqual([
    stuck.id,
  ]);
  // The job running again changes nothing.
  expect(await w.run(stuck.id)).toMatchObject({ status: "skipped", reason: "status_unknown" });
  expect(w.provider[WRITE[kind]]).not.toHaveBeenCalled();
  return { w, stuck };
}

/** S2: the handover got no clear answer: unknown, and no retry. */
async function noAnswerAfterHandover(kind: "invite" | "message" | "comment", error: Error) {
  const w = await world(kind);
  w.provider[WRITE[kind]].mockRejectedValueOnce(error);
  const message = await w.action(kind);
  const result = await w.run(message.id);
  expect(result).toMatchObject({ status: "unknown", message_id: message.id });
  expect(await w.reload(message.id)).toMatchObject({ status: "unknown", attempt: 1 });
  expect(w.ctx.emitted("message.failed")).toHaveLength(0);
  // Nothing tries it again on its own: a second run of the job is a no-op.
  w.ctx.clock.advanceBy({ minutes: 15 });
  expect(await w.run(message.id)).toMatchObject({ status: "skipped", reason: "status_unknown" });
  expect(w.provider[WRITE[kind]]).toHaveBeenCalledTimes(1);
  return { w, message };
}

/** S3: the provider took it but its answer carried no id: sent, never failed. */
async function acceptedWithoutId(kind: "invite" | "message" | "comment") {
  const w = await world(kind);
  if (kind === "invite") w.provider.sendInvite.mockResolvedValueOnce({});
  if (kind === "message") w.provider.sendMessage.mockResolvedValueOnce({});
  if (kind === "comment") w.provider.commentOnPost.mockResolvedValueOnce({});
  const message = await w.action(kind);
  expect(await w.run(message.id)).toEqual({ status: "sent", message_id: message.id });
  const row = await w.reload(message.id);
  expect(row).toMatchObject({ status: "sent", provider_message_id: null });
  expect(row.sent_at?.toISOString()).toBe(NOW);
  expect(w.ctx.emitted("message.sent")).toHaveLength(1);
  return { w, row };
}

/** S4: two workers run the same action at once: exactly one handover. */
async function twoWorkersAtOnce(kind: "invite" | "message" | "comment") {
  const w = await world(kind);
  const held = heldCall(() =>
    kind === "invite"
      ? { providerRef: "ACoAAdana" }
      : kind === "message"
        ? { messageId: "li_msg_1", chatId: "chat_dana" }
        : { commentId: "li_comment_1" },
  );
  // biome-ignore lint/suspicious/noExplicitAny: one held answer for three write signatures
  (w.provider[WRITE[kind]] as any).mockImplementationOnce(held.call);
  const message = await w.action(kind);
  const first = w.run(message.id);
  const second = w.run(message.id);
  await waitUntil(() => w.provider[WRITE[kind]].mock.calls.length === 1);
  // The second worker found the action claimed (or mid-send) and did not hand it over.
  const other = await second;
  expect(["skipped", "unknown"]).toContain(other.status);
  held.release();
  expect(await first).toEqual({ status: "sent", message_id: message.id });
  expect(w.provider[WRITE[kind]]).toHaveBeenCalledTimes(1);
  expect(await w.reload(message.id)).toMatchObject({ status: "sent", attempt: 1 });
  expect(w.ctx.emitted("message.sent")).toHaveLength(1);
}

/** S5: an error before the handover: the same row goes out on the next try. */
async function retriedOnTheSameRow(
  w: World,
  kind: "invite" | "message" | "comment",
  fail: () => void,
  over: Partial<Message> = {},
) {
  fail();
  const message = await w.action(kind, over);
  await expect(w.run(message.id)).rejects.toBeInstanceOf(OpenOutboundError);
  expect(await w.reload(message.id)).toMatchObject({ status: "scheduled", attempt: 1 });
  // The job's retry sends the same row: no new message, no new id.
  w.ctx.clock.advanceBy({ minutes: 15 });
  expect(await w.run(message.id)).toEqual({ status: "sent", message_id: message.id });
  expect(await w.reload(message.id)).toMatchObject({ status: "sent", attempt: 2 });
  const rows = await w.ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.workspace_id, w.ctx.workspace.id), eq(messages.channel, "linkedin")));
  expect(rows.map((row) => row.id)).toEqual([message.id]);
  return message;
}

/**
 * S6: the first attempt hangs, its job's retry finds it mid-send (unknown), a person resends,
 * the resend goes out, then the first attempt's success comes back: a recorded duplicate.
 */
async function lateSuccessAfterResend(kind: "invite" | "message" | "comment") {
  const w = await world(kind);
  const held = heldCall(() =>
    kind === "invite"
      ? { providerRef: "ACoAAdana" }
      : kind === "message"
        ? { messageId: "li_msg_1", chatId: "chat_dana" }
        : { commentId: "li_comment_1" },
  );
  // biome-ignore lint/suspicious/noExplicitAny: one held answer for three write signatures
  (w.provider[WRITE[kind]] as any).mockImplementationOnce(held.call);
  const message = await w.action(kind);
  const first = w.run(message.id);
  await waitUntil(() => w.provider[WRITE[kind]].mock.calls.length === 1);
  expect(await w.run(message.id)).toMatchObject({ status: "unknown" });
  await resolveUnknownOperation.handler(
    w.ctx,
    resolveUnknownOperation.input.parse({ message_id: message.id, outcome: "resend" }),
  );
  w.ctx.clock.advanceBy({ minutes: 15 });
  expect(await w.run(message.id)).toEqual({ status: "sent", message_id: message.id });
  expect(await w.reload(message.id)).toMatchObject({ status: "sent", attempt: 2 });

  held.release();
  expect(await first).toMatchObject({ status: "duplicate", message_id: message.id });
  expect(w.provider[WRITE[kind]]).toHaveBeenCalledTimes(2);
  const row = await w.reload(message.id);
  expect(row).toMatchObject({ status: "sent", attempt: 2 });
  expect(row.why?.duplicate_attempts).toEqual([1, 2]);
  expect(w.ctx.emitted("message.sent")).toHaveLength(1);
  expect(w.ctx.emitted("message.duplicate").map((event) => event.data)).toEqual([
    expect.objectContaining({ message_id: message.id, attempts: [1, 2], channel: "linkedin" }),
  ]);
  const [problem] = await w.openProblems("duplicate_send");
  expect(problem).toMatchObject({
    severity: "normal",
    owner: "person",
    dedupe_key: `duplicate_send:${message.id}`,
  });
  return { w, message, problem };
}

describe("delivery invariant: LinkedIn invitation (B3)", () => {
  it("B3 S1 an invitation found mid-send becomes unknown and is not sent again", async () => {
    const { w } = await foundMidSend("invite");
    // Invitations wait for the profile check instead of a person.
    expect(await w.openProblems("send_unknown")).toHaveLength(0);
  });

  it("B3 S2 an invitation whose job times out mid-call becomes unknown, never retried", async () => {
    const w = await world("invite");
    w.provider.sendInvite.mockImplementationOnce(
      (_account, _target, _note, options) =>
        new Promise((_resolve, reject) => {
          // The provider stops when the job's signal fires, like a fetch does.
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
    );
    const message = await w.action("invite");
    const job = new AbortController();
    const running = w.run(message.id, job.signal);
    await waitUntil(() => w.provider.sendInvite.mock.calls.length === 1);
    expect(w.provider.sendInvite.mock.calls[0]?.[3]?.signal).toBe(job.signal);
    job.abort();
    expect(await running).toMatchObject({ status: "unknown" });
    expect(await w.reload(message.id)).toMatchObject({ status: "unknown", attempt: 1 });
    w.ctx.clock.advanceBy({ minutes: 15 });
    expect(await w.run(message.id)).toMatchObject({ reason: "status_unknown" });
    expect(w.provider.sendInvite).toHaveBeenCalledTimes(1);
  });

  it("B3 S3 an invitation LinkedIn took without an id counts as sent", async () => {
    const { w } = await acceptedWithoutId("invite");
    expect(w.ctx.emitted("message.sent")[0]?.data).toMatchObject({ action: "invite" });
  });

  it("B3 S4 two workers running the same invitation hand it over once", async () => {
    await twoWorkersAtOnce("invite");
  });

  it("B3 S5 an invitation whose profile lookup failed is retried on the same row", async () => {
    const w = await world("invite");
    await retriedOnTheSameRow(w, "invite", () =>
      w.provider.getProfile.mockRejectedValueOnce(serverError("GET /users/:id")),
    );
    expect(w.provider.sendInvite).toHaveBeenCalledTimes(1);
  });

  it("B3 S6 an invitation whose first try succeeds after the resend is recorded as a duplicate", async () => {
    const { problem } = await lateSuccessAfterResend("invite");
    expect(problem?.title).toBe("LinkedIn invitation went out twice");
  });

  it("B3 S6 an invitation whose first try's answer comes while its resend looks it up is sent once", async () => {
    const w = await world("invite");
    const invite = await w.action("invite", {
      status: "scheduled",
      attempt: 1,
      dispatch_started_at: new Date(NOW),
      why: { resent_after_unknown: NOW },
    });
    // While the resend reads the profile, the first try's late answer says it went out.
    w.provider.getProfile.mockImplementationOnce(async () => {
      await w.ctx.db
        .update(messages)
        .set({ why: { resent_after_unknown: NOW, earlier_attempt_went_out: 1 } })
        .where(eq(messages.id, invite.id));
      return {
        provider_id: "ACoAAdana",
        profile_url: w.person.linkedin_url ?? "",
        connection_degree: 2,
        invitation_pending: true,
      };
    });
    expect(await w.run(invite.id)).toMatchObject({ status: "sent", message_id: invite.id });
    expect(await w.reload(invite.id)).toMatchObject({ status: "sent", attempt: 2 });
    expect(w.provider.sendInvite).not.toHaveBeenCalled();
    expect(w.ctx.emitted("message.sent")).toHaveLength(1);
    // The resend sent nothing: no copy too many.
    expect(await w.openProblems("duplicate_send")).toEqual([]);
  });

  it("B3 S8 an invitation sent again that finds the first one pending or accepted is recorded as sent", async () => {
    for (const found of ["pending", "accepted"] as const) {
      const w = await world("invite");
      const invite = await w.action("invite", {
        status: "unknown",
        attempt: 1,
        dispatch_started_at: new Date(NOW),
      });
      const reconcile = () => reconcileLinkedInUnknowns(w.ctx.jobContext());
      // Three lookups show no invitation: it is sent again once.
      await reconcile();
      await reconcile();
      expect(await reconcile()).toMatchObject({ resent: 1 });
      // By the resend, LinkedIn shows the first one after all: that try went out.
      w.provider.getProfile.mockResolvedValueOnce({
        provider_id: "ACoAAdana",
        profile_url: w.person.linkedin_url ?? "",
        connection_degree: found === "accepted" ? 1 : 2,
        invitation_pending: found === "pending",
      });
      w.ctx.clock.advanceBy({ minutes: 15 });
      expect(await w.run(invite.id), found).toMatchObject({
        status: "sent",
        message_id: invite.id,
      });
      expect(await w.reload(invite.id), found).toMatchObject({ status: "sent", attempt: 2 });
      expect(w.provider.sendInvite).not.toHaveBeenCalled();
      expect(w.ctx.emitted("message.sent"), found).toHaveLength(1);
      expect(w.ctx.emitted("message.failed"), found).toHaveLength(0);
      const relation = await findRelation(w.ctx.db, w.account.id, w.person.id);
      expect(relation?.status, found).toBe(found === "accepted" ? "connected" : "invited");
    }
  });

  it("B3 S8 an invitation is sent again once only when LinkedIn shows none, then a person decides", async () => {
    const w = await world("invite");
    const invite = await w.action("invite", {
      status: "unknown",
      attempt: 1,
      dispatch_started_at: new Date(NOW),
    });
    const reconcile = () => reconcileLinkedInUnknowns(w.ctx.jobContext());
    // No invitation on the live profile: not yet a proof after one or two lookups.
    expect(await reconcile()).toMatchObject({ pending: 1, resent: 0 });
    expect(await reconcile()).toMatchObject({ pending: 1, resent: 0 });
    // Still none at the third lookup: the proof. Sent again once.
    expect(await reconcile()).toMatchObject({ resent: 1 });
    expect(await w.reload(invite.id)).toMatchObject({ status: "scheduled", attempt: 1 });
    expect(w.provider.sendInvite).not.toHaveBeenCalled();
    // The one extra try is unclear too: never a third, a person decides.
    w.ctx.clock.advanceBy({ minutes: 15 });
    w.provider.sendInvite.mockRejectedValueOnce(timeout("POST /users/invite"));
    expect(await w.run(invite.id)).toMatchObject({ status: "unknown" });
    expect(await w.reload(invite.id)).toMatchObject({ status: "unknown", attempt: 2 });
    await reconcile();
    await reconcile();
    expect(await reconcile()).toMatchObject({ problems: 1, resent: 0 });
    expect((await w.reload(invite.id)).status).toBe("unknown");
    expect(w.provider.sendInvite).toHaveBeenCalledTimes(1);
    const [problem] = await w.openProblems("send_unknown");
    expect(problem?.reason).toContain("even after it was sent again once");
    // Nothing is looked up or sent again.
    expect(await reconcile()).toMatchObject({ checked: 0 });
  });
});

describe("delivery invariant: LinkedIn message (B4)", () => {
  it("B4 S1 a message found mid-send becomes unknown and is not sent again", async () => {
    const { w, stuck } = await foundMidSend("message");
    const [problem] = await w.openProblems("send_unknown");
    expect(problem).toMatchObject({ subject_id: stuck.id });
  });

  it("B4 S2 a message whose connection dropped after the request becomes unknown, never retried", async () => {
    const { w } = await noAnswerAfterHandover("message", droppedConnection("POST /chats"));
    expect(await w.openProblems("send_unknown")).toHaveLength(1);
  });

  it("B4 S2 a message answered with a server error that mentions a verification becomes unknown", async () => {
    const error = await unipileFailure(async () =>
      Response.json(
        {
          status: 500,
          type: "errors/unexpected_error",
          title: "Internal error",
          detail: "Upstream verification step timed out",
        },
        { status: 500 },
      ),
    );
    const { w } = await noAnswerAfterHandover("message", error);
    // A server error says nothing about the account: it stays active, nothing is parked.
    const [account] = await w.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, w.account.id));
    expect(account?.status).toBe("active");
  });

  it("B4 S3 a message LinkedIn took without an id counts as sent", async () => {
    await acceptedWithoutId("message");
  });

  it("B4 S4 two workers running the same message hand it over once", async () => {
    await twoWorkersAtOnce("message");
  });

  it("B4 S5 a message whose connection never opened is retried on the same row", async () => {
    const w = await world();
    await retriedOnTheSameRow(w, "message", () =>
      w.provider.sendMessage.mockRejectedValueOnce(refusedConnection("POST /chats")),
    );
    expect(w.provider.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("B4 S5 a message whose connection timed out while opening is retried on the same row", async () => {
    const w = await world();
    const error = await unipileFailure(connectTimeout);
    await retriedOnTheSameRow(w, "message", () =>
      w.provider.sendMessage.mockRejectedValueOnce(error),
    );
    expect(w.provider.sendMessage).toHaveBeenCalledTimes(2);
    expect(w.ctx.emitted("message.unknown")).toHaveLength(0);
  });

  it("B4 S5 a message its job stopped before the call is retried on the same row", async () => {
    const w = await world();
    // The job's time ran out before the call: the client refuses it without sending.
    const error = await unipileFailure(connectTimeout, AbortSignal.abort());
    await retriedOnTheSameRow(w, "message", () =>
      w.provider.sendMessage.mockRejectedValueOnce(error),
    );
    expect(w.ctx.emitted("message.unknown")).toHaveLength(0);
  });

  it("B4 S6 a message whose first try succeeds after the resend is recorded as a duplicate", async () => {
    const { problem } = await lateSuccessAfterResend("message");
    expect(problem?.title).toBe("LinkedIn message went out twice");
    expect(problem?.reason).toContain("Dana Reyes");
  });

  it("records a reply moved back to review while it went out as sent, and cancels its approval", async () => {
    const w = await world();
    const held = heldCall(() => ({ messageId: "li_msg_1", chatId: "chat_dana" }));
    w.provider.sendMessage.mockImplementationOnce(held.call);
    const reply = await w.action("message");
    const running = w.run(reply.id);
    await waitUntil(() => w.provider.sendMessage.mock.calls.length === 1);
    // While LinkedIn holds the message, something wrote over the claim: the reply waits for
    // review again, with an approval that would send it a second time.
    await w.ctx.db
      .update(messages)
      .set({ status: "pending_review" })
      .where(eq(messages.id, reply.id));
    const asked = await w.ctx.approvals.request({
      kind: "reply",
      title: "Reply to Dana Reyes",
      summary: "Send: Thanks for connecting, Dana.",
      payload: { message_id: reply.id },
      target: { type: "message", id: reply.id },
    });
    held.release();
    expect(await running).toMatchObject({ status: "sent", message_id: reply.id });
    expect(await w.reload(reply.id)).toMatchObject({ status: "sent", attempt: 1 });
    const [approval] = await w.ctx.db.select().from(approvals).where(eq(approvals.id, asked.id));
    expect(approval?.status).toBe("cancelled");
    expect(w.ctx.emitted("message.sent")).toHaveLength(1);
  });

  it("B4 S8 a message is never sent again on its own: a person decides", async () => {
    const w = await world();
    w.provider.sendMessage.mockRejectedValueOnce(timeout("POST /chats"));
    const message = await w.action("message");
    expect(await w.run(message.id)).toMatchObject({ status: "unknown" });
    // The engine cannot prove a LinkedIn message did not arrive: no automatic extra try.
    for (let run = 0; run < 4; run++) {
      await reconcileLinkedInUnknowns(w.ctx.jobContext());
      w.ctx.clock.advanceBy({ minutes: 10 });
    }
    expect(await w.reload(message.id)).toMatchObject({ status: "unknown", attempt: 1 });
    expect(w.ctx.enqueued("linkedin.action")).toHaveLength(0);
    expect(w.provider.sendMessage).toHaveBeenCalledTimes(1);
    const [problem] = await w.openProblems("send_unknown");
    expect(problem?.remedy).toContain("resolve_unknown");
  });
});

describe("delivery invariant: LinkedIn comment (B5)", () => {
  it("B5 S1 a comment found mid-send becomes unknown and is not sent again", async () => {
    const { w, stuck } = await foundMidSend("comment");
    const [problem] = await w.openProblems("send_unknown");
    expect(problem).toMatchObject({
      subject_id: stuck.id,
      title: "Check whether a LinkedIn comment went out",
    });
  });

  it("B5 S2 a comment that timed out after the request becomes unknown, never retried", async () => {
    await noAnswerAfterHandover("comment", timeout("POST /posts/:id/comments"));
  });

  it("B5 S3 a comment LinkedIn took without an id counts as sent", async () => {
    const { row } = await acceptedWithoutId("comment");
    expect(row.in_reply_to).toBe(POST);
  });

  it("B5 S4 two workers running the same comment hand it over once", async () => {
    await twoWorkersAtOnce("comment");
  });

  it("B5 S5 a comment whose post lookup failed is retried on the same row", async () => {
    const w = await world("comment");
    // No post chosen yet: the comment looks for the newest one first.
    await retriedOnTheSameRow(
      w,
      "comment",
      () => w.provider.listRecentPosts.mockRejectedValueOnce(serverError("GET /users/:id/posts")),
      { in_reply_to: null },
    );
    expect(w.provider.commentOnPost).toHaveBeenCalledTimes(1);
  });

  it("B5 S6 a comment whose first try succeeds after the resend is recorded as a duplicate", async () => {
    const { problem } = await lateSuccessAfterResend("comment");
    expect(problem?.title).toBe("LinkedIn comment went out twice");
    expect(problem?.remedy).toContain("delete the extra copy on LinkedIn");
  });

  it("B5 S8 a comment is never sent again on its own: a person decides", async () => {
    const w = await world("comment");
    w.provider.commentOnPost.mockRejectedValueOnce(timeout("POST /posts/:id/comments"));
    const comment = await w.action("comment");
    expect(await w.run(comment.id)).toMatchObject({ status: "unknown" });
    for (let run = 0; run < 4; run++) {
      await reconcileLinkedInUnknowns(w.ctx.jobContext());
      w.ctx.clock.advanceBy({ minutes: 10 });
    }
    expect(await w.reload(comment.id)).toMatchObject({ status: "unknown", attempt: 1 });
    expect(w.ctx.enqueued("linkedin.action")).toHaveLength(0);
    expect(w.provider.commentOnPost).toHaveBeenCalledTimes(1);
    const [problem] = await w.openProblems("send_unknown");
    expect(problem?.remedy).toContain("the post's comments on LinkedIn");
  });
});
