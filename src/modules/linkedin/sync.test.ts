import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../core/engine.js";
import { OpenOutboundError } from "../../core/errors.js";
import { providerFailure } from "../../core/failures.js";
import {
  type LinkedInAccount,
  linkedin_accounts,
  linkedin_relations,
  messages,
  threads,
  workspaces,
} from "../../db/schema/index.js";
import type { LinkedInInboundMessage, LinkedInProvider } from "../../providers/types.js";
import { createTestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount, seedMessage, seedPerson } from "../../testing/factories.js";
import { encodeAuthState, LINKED_ELSEWHERE_REASON, pollPendingAccount } from "./hosted-auth.js";
import { ingestInboundMessage } from "./inbound.js";
import { markConnected, upsertRelation } from "./relations.js";
import { processLinkedInEvent, syncAccount, withdrawStaleInvites } from "./sync.js";
import { unipileRoutes } from "./webhook.js";

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

function fakeProvider() {
  return {
    id: "unipile",
    getProfile: vi.fn(async () => ({ provider_id: "x", profile_url: "" })),
    visitProfile: vi.fn(async () => {}),
    sendInvite: vi.fn(async () => ({})),
    sendMessage: vi.fn(async () => ({ messageId: "m" })),
    listRecentPosts: vi.fn(async () => []),
    reactToPost: vi.fn(async () => {}),
    commentOnPost: vi.fn(async () => ({})),
    listAccounts: vi.fn(async () => [
      { external_account_id: "acct_old", name: "Old", status: "active" as const },
    ]),
    syncRelations: vi.fn(async () => ({
      connections: [] as Array<{
        provider_id: string;
        profile_url?: string | null;
        connected_at?: string | null;
      }>,
    })),
    syncMessages: vi.fn(async () => ({ messages: [] as LinkedInInboundMessage[] })),
    listPendingInvites: vi.fn(
      async () =>
        [] as Array<{
          invitation_id: string;
          provider_id: string;
          profile_url?: string | null;
          sent_at?: string | null;
        }>,
    ),
    withdrawInvite: vi.fn(async (_account: string, _invitationId: string) => {}),
    parseWebhook: vi.fn(async (body: unknown, _headers: Record<string, string>) => {
      const record = body as { events?: unknown[] };
      return (record.events ?? []) as Awaited<
        ReturnType<NonNullable<LinkedInProvider["parseWebhook"]>>
      >;
    }),
  } satisfies LinkedInProvider;
}

async function setup(options: { now?: string; account?: Partial<LinkedInAccount> } = {}) {
  const provider = fakeProvider();
  const ctx = await createTestContext({
    db,
    now: options.now ?? NOW,
    providers: { linkedin: provider },
  });
  const account = await seedLinkedInAccount(ctx, { provider: "unipile", ...options.account });
  const slug = Math.random().toString(36).slice(2, 8);
  const person = await seedPerson(ctx, {
    linkedin_url: `https://www.linkedin.com/in/lead-${slug}`,
  });
  const job = () => ctx.jobContext({ name: "linkedin.sync" });
  return { ctx, provider, account, person, slug, job };
}

const inbound = (over: Partial<LinkedInInboundMessage> = {}): LinkedInInboundMessage => ({
  id: "in_1",
  chat_id: "chat_9",
  sender_provider_id: "ACoAAlead",
  text: "Sounds interesting, tell me more.",
  sent_at: "2026-09-22T14:30:00Z",
  is_outbound: false,
  ...over,
});

describe("sync: accepted invitations", () => {
  it("marks invited people connected once and emits linkedin.connected", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "invited",
      providerRef: "ACoAAlead",
    });
    s.provider.syncRelations.mockResolvedValue({
      connections: [{ provider_id: "ACoAAlead", connected_at: "2026-09-22T13:00:00Z" }],
    });
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      connected: 1,
    });
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      connected: 0,
    });
    const events = s.ctx.emitted("linkedin.connected");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({
      account_id: s.account.id,
      person_id: s.person.id,
      connected_at: "2026-09-22T13:00:00.000Z",
    });
  });

  it("matches by profile URL and ignores people outside the workspace", async () => {
    const s = await setup();
    s.provider.syncRelations.mockResolvedValue({
      connections: [
        { provider_id: "ACoAAnew", profile_url: `https://linkedin.com/in/LEAD-${s.slug}/` },
        { provider_id: "ACoAAstranger", profile_url: "https://www.linkedin.com/in/someone-else" },
      ],
    });
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      connected: 1,
    });
    const [relation] = await s.ctx.db
      .select()
      .from(linkedin_relations)
      .where(eq(linkedin_relations.person_id, s.person.id));
    expect(relation).toMatchObject({ status: "connected", provider_ref: "ACoAAnew" });
  });
});

describe("sync: inbound messages", () => {
  it("threads inbound messages, emits reply.received and stays idempotent", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "connected",
      providerRef: "ACoAAlead",
    });
    s.provider.syncMessages.mockResolvedValue({
      messages: [
        inbound(),
        inbound({ id: "out_1", is_outbound: true }),
        inbound({ id: "in_x", chat_id: "chat_x", sender_provider_id: "ACoAAstranger" }),
      ],
    });
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      messages: 1,
      unmatched: 1,
    });
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      messages: 0,
      duplicates: 1,
    });
    const rows = await s.ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.workspace_id, s.ctx.workspace.id), eq(messages.direction, "inbound")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "linkedin",
      status: "received",
      person_id: s.person.id,
      provider_message_id: "in_1",
      body_text: "Sounds interesting, tell me more.",
    });
    const [thread] = await s.ctx.db
      .select()
      .from(threads)
      .where(eq(threads.id, rows[0]?.thread_id ?? ""));
    expect(thread).toMatchObject({ external_ref: "chat_9", linkedin_account_id: s.account.id });
    expect(s.ctx.emitted("reply.received")).toHaveLength(1);
    expect(s.ctx.emitted("reply.received")[0]?.data).toMatchObject({ channel: "linkedin" });
  });

  it("stores a message seen by the webhook and the sync at the same time once", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "connected",
      providerRef: "ACoAAlead",
    });
    const race = inbound({ id: "in_race" });
    const results = await Promise.all([
      ingestInboundMessage(s.ctx, s.account, race),
      ingestInboundMessage(s.ctx, s.account, race),
    ]);
    expect(results.map((item) => item.result).sort()).toEqual(["created", "duplicate"]);
    expect(s.ctx.emitted("reply.received")).toHaveLength(1);

    const again = await Promise.all([
      markConnected(s.ctx, s.account, s.person.id),
      markConnected(s.ctx, s.account, s.person.id),
    ]);
    // Already connected: no transition, no event.
    expect(again).toEqual([false, false]);
    expect(s.ctx.emitted("linkedin.connected")).toHaveLength(0);

    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "invited",
    });
    const transitions = await Promise.all([
      markConnected(s.ctx, s.account, s.person.id),
      markConnected(s.ctx, s.account, s.person.id),
    ]);
    expect(transitions.filter(Boolean)).toHaveLength(1);
    expect(s.ctx.emitted("linkedin.connected")).toHaveLength(1);
  });
});

describe("sync: auto-withdraw", () => {
  it("withdraws invitations pending for more than 21 days, inside working hours", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "invited",
      invitedAt: new Date("2026-08-28T15:00:00Z"),
      providerRef: "ACoAAold",
    });
    s.provider.listPendingInvites.mockResolvedValue([
      { invitation_id: "inv_old", provider_id: "ACoAAold", sent_at: "2026-08-28T15:00:00Z" },
      { invitation_id: "inv_new", provider_id: "ACoAAnew", sent_at: "2026-09-17T15:00:00Z" },
      { invitation_id: "inv_undated", provider_id: "ACoAAundated", sent_at: null },
    ]);
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      withdrawn: 1,
    });
    expect(s.provider.withdrawInvite).toHaveBeenCalledWith(
      s.account.external_account_id,
      "inv_old",
      { signal: expect.any(AbortSignal) },
    );
    const [relation] = await s.ctx.db
      .select()
      .from(linkedin_relations)
      .where(eq(linkedin_relations.person_id, s.person.id));
    expect(relation?.status).toBe("withdrawn");
    expect(relation?.withdrawn_at?.toISOString()).toBe(NOW);
  });

  it("claims an invitation before withdrawing it, so two runs withdraw it once", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "invited",
      invitedAt: new Date("2026-08-28T15:00:00Z"),
      providerRef: "ACoAAold",
    });
    s.provider.listPendingInvites.mockResolvedValue([
      { invitation_id: "inv_old", provider_id: "ACoAAold", sent_at: "2026-08-28T15:00:00Z" },
    ]);
    let release: () => void = () => {};
    s.provider.withdrawInvite.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const first = withdrawStaleInvites(s.job(), s.account);
    const second = withdrawStaleInvites(s.job(), s.account);
    for (let i = 0; i < 200 && s.provider.withdrawInvite.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The second run finds the invitation claimed and leaves it alone.
    expect(await second).toBe(0);
    release();
    expect(await first).toBe(1);
    expect(s.provider.withdrawInvite).toHaveBeenCalledTimes(1);
  });

  it("puts an invitation back when its withdrawal fails, and keeps one already gone withdrawn", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "invited",
      invitedAt: new Date("2026-08-28T15:00:00Z"),
      providerRef: "ACoAAold",
    });
    s.provider.listPendingInvites.mockResolvedValue([
      { invitation_id: "inv_old", provider_id: "ACoAAold", sent_at: "2026-08-28T15:00:00Z" },
    ]);
    const relation = async () => {
      const [row] = await s.ctx.db
        .select()
        .from(linkedin_relations)
        .where(eq(linkedin_relations.person_id, s.person.id));
      return row;
    };
    s.provider.withdrawInvite.mockRejectedValueOnce(
      new OpenOutboundError(
        "provider_error",
        "Unipile DELETE /users/invite/sent/:id failed (503)",
        {
          details: { provider: "unipile", status: 503, retryable: true },
        },
      ),
    );
    const failed = await syncAccount(s.job(), s.ctx.workspace.id, s.account.id);
    expect(failed).toMatchObject({ withdrawn: 0, error: expect.stringContaining("503") });
    expect(await relation()).toMatchObject({ status: "invited", withdrawn_at: null });

    // LinkedIn no longer has it (accepted or withdrawn by hand): nothing left to withdraw.
    s.provider.withdrawInvite.mockRejectedValueOnce(
      new OpenOutboundError(
        "provider_error",
        "Unipile DELETE /users/invite/sent/:id failed (404)",
        {
          details: { provider: "unipile", status: 404, retryable: false },
        },
      ),
    );
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      withdrawn: 0,
    });
    expect((await relation())?.status).toBe("withdrawn");
  });

  it("leaves the owner's own invitations alone and withdraws two per run", async () => {
    const s = await setup();
    const second = await seedPerson(s.ctx, {
      linkedin_url: `https://www.linkedin.com/in/lead-b-${s.slug}`,
    });
    const third = await seedPerson(s.ctx, {
      linkedin_url: `https://www.linkedin.com/in/lead-c-${s.slug}`,
    });
    const tracked = [
      { personId: s.person.id, providerRef: "ACoAAtracked0" },
      { personId: second.id, providerRef: "ACoAAtracked1" },
      { personId: third.id, providerRef: null },
    ];
    for (const item of tracked) {
      await upsertRelation(s.ctx.db, {
        workspaceId: s.ctx.workspace.id,
        accountId: s.account.id,
        personId: item.personId,
        status: "invited",
        invitedAt: new Date("2026-08-20T15:00:00Z"),
        providerRef: item.providerRef,
      });
    }
    s.provider.listPendingInvites.mockResolvedValue([
      {
        invitation_id: "inv_owner",
        provider_id: "ACoAAownerfriend",
        profile_url: "https://www.linkedin.com/in/owner-friend",
        sent_at: "2026-08-01T15:00:00Z",
      },
      { invitation_id: "inv_t0", provider_id: "ACoAAtracked0", sent_at: "2026-08-20T15:00:00Z" },
      { invitation_id: "inv_t1", provider_id: "ACoAAtracked1", sent_at: "2026-08-21T15:00:00Z" },
      {
        invitation_id: "inv_url",
        provider_id: "ACoAAunknownid",
        profile_url: `https://www.linkedin.com/in/lead-c-${s.slug}`,
        sent_at: "2026-08-19T15:00:00Z",
      },
    ]);
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      withdrawn: 2,
    });
    expect(s.provider.withdrawInvite.mock.calls.map((call) => call[1])).toEqual([
      "inv_url",
      "inv_t0",
    ]);
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      withdrawn: 1,
    });
    expect(s.provider.withdrawInvite.mock.calls.map((call) => call[1])).toEqual([
      "inv_url",
      "inv_t0",
      "inv_t1",
    ]);
  });

  it("re-queues overdue actions after a failed listing, and withdraws only after a clean sync", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "invited",
      invitedAt: new Date("2026-08-28T15:00:00Z"),
      providerRef: "ACoAAold",
    });
    s.provider.listPendingInvites.mockResolvedValue([
      { invitation_id: "inv_old", provider_id: "ACoAAold", sent_at: "2026-08-28T15:00:00Z" },
    ]);
    // A message action whose job was lost while the workers were down.
    const overdue = await seedMessage(s.ctx, {
      channel: "linkedin",
      action: "message",
      status: "scheduled",
      subject: null,
      body_text: "Thanks for connecting.",
      linkedin_account_id: s.account.id,
      person_id: s.person.id,
      scheduled_for: new Date(Date.parse(NOW) - 60 * 60_000),
    });
    s.provider.syncMessages.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "timeout" }),
    );
    const failed = await syncAccount(s.job(), s.ctx.workspace.id, s.account.id);
    expect(failed).toMatchObject({ failure: { class: "timeout" }, requeued: 1, withdrawn: 0 });
    expect(s.ctx.enqueued("linkedin.action").map((job) => job.payload)).toEqual([
      { message_id: overdue.id },
    ]);
    expect(s.provider.withdrawInvite).not.toHaveBeenCalled();

    const clean = await syncAccount(s.job(), s.ctx.workspace.id, s.account.id);
    expect(clean).toMatchObject({ withdrawn: 1 });
    expect(clean).not.toHaveProperty("failure");
  });

  it("does not withdraw at night or on weekends", async () => {
    const s = await setup({ now: "2026-09-19T12:00:00.000Z" });
    s.provider.listPendingInvites.mockResolvedValue([
      { invitation_id: "inv_old", provider_id: "ACoAAold", sent_at: "2026-08-01T15:00:00Z" },
    ]);
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toMatchObject({
      withdrawn: 0,
    });
    expect(s.provider.withdrawInvite).not.toHaveBeenCalled();
  });

  it("keeps reading but takes no action while the workspace is paused", async () => {
    const s = await setup();
    await s.ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, s.ctx.workspace.id));
    s.provider.listPendingInvites.mockResolvedValue([
      { invitation_id: "inv_old", provider_id: "ACoAAold", sent_at: "2026-08-01T15:00:00Z" },
    ]);
    s.provider.syncMessages.mockResolvedValue({ messages: [inbound({ id: "in_paused" })] });
    const result = await syncAccount(s.job(), s.ctx.workspace.id, s.account.id);
    expect(result).toMatchObject({ withdrawn: 0, requeued: 0 });
    expect(s.provider.syncMessages).toHaveBeenCalledTimes(1);
    expect(s.provider.withdrawInvite).not.toHaveBeenCalled();
  });
});

describe("sync: account state", () => {
  it("restricts the account when the provider reports a restriction", async () => {
    const s = await setup();
    s.provider.syncRelations.mockRejectedValue(
      new OpenOutboundError("provider_error", "restricted", { details: { restricted: true } }),
    );
    const result = await syncAccount(s.job(), s.ctx.workspace.id, s.account.id);
    expect(result).toMatchObject({ error: "restricted" });
    const [account] = await s.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, s.account.id));
    expect(account?.status).toBe("restricted");
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toEqual({
      skipped: "account_restricted",
    });
  });

  it("completes a pending account by poll when exactly one new account appeared", async () => {
    const s = await setup({
      account: {
        status: "pending",
        external_account_id: null,
        ramp: { enabled: true, start: 40, increment: 30, every_days: 7 },
        sync_state: { pending_auth: { requested_at: NOW, known_account_ids: ["acct_old"] } },
      },
    });
    s.provider.listAccounts.mockResolvedValue([
      { external_account_id: "acct_old", name: "Old", status: "active" },
      { external_account_id: "acct_new", name: "Dana Reyes", status: "active" },
    ]);
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toEqual({
      account_id: s.account.id,
      status: "active",
    });
    const [account] = await s.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, s.account.id));
    expect(account).toMatchObject({
      status: "active",
      external_account_id: "acct_new",
      name: "Sam Sender",
    });
    expect(account?.ramp?.started_at).toBe("2026-09-22");
  });

  it("keeps a pending account pending when the match is ambiguous", async () => {
    const s = await setup({
      account: {
        status: "pending",
        external_account_id: null,
        sync_state: { pending_auth: { requested_at: NOW, known_account_ids: [] } },
      },
    });
    s.provider.listAccounts.mockResolvedValue([
      { external_account_id: "acct_a", name: "A", status: "active" },
      { external_account_id: "acct_b", name: "B", status: "active" },
    ]);
    expect(await syncAccount(s.job(), s.ctx.workspace.id, s.account.id)).toEqual({
      account_id: s.account.id,
      status: "pending",
    });
  });

  it("waits for the signed callback while another login link is open", async () => {
    const s = await setup({
      account: {
        status: "pending",
        external_account_id: null,
        sync_state: { pending_auth: { requested_at: NOW, known_account_ids: ["acct_old"] } },
      },
    });
    const other = await createTestContext({ db, now: NOW });
    const rival = await seedLinkedInAccount(other, {
      provider: "unipile",
      status: "pending",
      external_account_id: null,
      sync_state: {
        pending_auth: {
          requested_at: NOW,
          expires_at: "2026-09-23T15:00:00.000Z",
          known_account_ids: ["acct_old"],
        },
      },
    });
    s.provider.listAccounts.mockResolvedValue([
      { external_account_id: "acct_old", name: "Old", status: "active" },
      { external_account_id: "acct_fresh", name: "Fresh", status: "active" },
    ]);
    // The new account may belong to either workspace: neither poll may claim it.
    expect(await pollPendingAccount(s.job(), s.account)).toEqual({
      status: "pending",
      reason: "concurrent_connections",
    });
    expect(s.provider.listAccounts).not.toHaveBeenCalled();
    await s.ctx.db
      .update(linkedin_accounts)
      .set({ status: "disconnected" })
      .where(eq(linkedin_accounts.id, rival.id));
  });
});

describe("webhook events", () => {
  it("applies message, relation and status events idempotently", async () => {
    const s = await setup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "invited",
      providerRef: "ACoAAlead",
    });
    const accepted = {
      type: "invite_accepted" as const,
      account_id: "acct",
      provider_id: "ACoAAlead",
      occurred_at: NOW,
    };
    expect(await processLinkedInEvent(s.ctx, s.account, accepted)).toMatchObject({
      connected: true,
    });
    expect(await processLinkedInEvent(s.ctx, s.account, accepted)).toMatchObject({
      connected: false,
    });

    const received = { type: "message_received" as const, account_id: "acct", message: inbound() };
    expect(await processLinkedInEvent(s.ctx, s.account, received)).toMatchObject({
      result: "created",
    });
    expect(await processLinkedInEvent(s.ctx, s.account, received)).toMatchObject({
      result: "duplicate",
    });

    const restricted = {
      type: "account_status" as const,
      account_id: "acct",
      status: "restricted" as const,
      reason: "ERROR",
    };
    expect(await processLinkedInEvent(s.ctx, s.account, restricted)).toMatchObject({
      changed: true,
    });
    const [account] = await s.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, s.account.id));
    expect(account?.status).toBe("restricted");
    // A healthy status afterwards never resumes a restricted account.
    const healthy = {
      type: "account_status" as const,
      account_id: "acct",
      status: "active" as const,
      reason: "OK",
    };
    expect(await processLinkedInEvent(s.ctx, account ?? s.account, healthy)).toMatchObject({
      changed: false,
      status: "restricted",
    });
    expect(s.ctx.emitted("linkedin.account_restricted")).toHaveLength(1);
    expect(s.ctx.emitted("linkedin.connected")).toHaveLength(1);
  });
});

describe("/hooks/unipile routes", () => {
  async function app(secret: string | undefined, s: Awaited<ReturnType<typeof setup>>) {
    const engine = {
      config: { ...s.ctx.config, env: secret ? { UNIPILE_WEBHOOK_SECRET: secret } : {} },
      db: s.ctx.db,
      systemContext: async () => s.ctx,
    } as unknown as Engine;
    const hono = new Hono();
    unipileRoutes(hono, { engine });
    return hono;
  }
  const post = (hono: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
    hono.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("requires the configured secret header", async () => {
    const s = await setup();
    expect((await post(await app(undefined, s), "/hooks/unipile", {})).status).toBe(503);
    const hono = await app("s3cret", s);
    expect((await post(hono, "/hooks/unipile", {})).status).toBe(401);
    expect(
      (await post(hono, "/hooks/unipile", {}, { "x-openoutbound-secret": "wrong" })).status,
    ).toBe(401);
    expect(
      (await post(hono, "/hooks/unipile", "{not json", { "x-openoutbound-secret": "s3cret" }))
        .status,
    ).toBe(400);
  });

  it("queues one job per event with a stable singleton key", async () => {
    const s = await setup();
    const hono = await app("s3cret", s);
    const body = {
      account_id: s.account.external_account_id,
      events: [{ type: "message_received", account_id: "x", message: inbound() }],
    };
    await s.ctx.db
      .update(linkedin_accounts)
      .set({ provider: "unipile" })
      .where(eq(linkedin_accounts.id, s.account.id));
    const response = await post(hono, "/hooks/unipile", body, {
      "x-openoutbound-secret": "s3cret",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 1 });
    await post(hono, "/hooks/unipile", body, { "x-openoutbound-secret": "s3cret" });
    const jobs = s.ctx.enqueued("linkedin.webhook_event");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.options.singletonKey).toBe(`linkedin.webhook:${s.account.id}:msg:in_1`);
    expect(s.provider.parseWebhook.mock.calls[0]?.[1]).not.toHaveProperty("x-openoutbound-secret");

    const unknown = await post(
      hono,
      "/hooks/unipile",
      { account_id: "nobody" },
      {
        "x-openoutbound-secret": "s3cret",
      },
    );
    expect(await unknown.json()).toEqual({ received: 0, ignored: "unknown_account" });
  });

  it("completes hosted auth only with a valid state", async () => {
    const s = await setup({ account: { status: "pending", external_account_id: null } });
    const hono = await app("s3cret", s);
    const state = encodeAuthState(s.ctx.vault, {
      ws: s.ctx.workspace.id,
      acc: s.account.id,
      exp: new Date(NOW).getTime() + 60_000,
    });
    const bad = await post(hono, "/hooks/unipile/auth?state=forged", { account_id: "acct_z" });
    expect(bad.status).toBe(400);
    const mismatch = await post(hono, `/hooks/unipile/auth?state=${state}`, {
      account_id: "acct_z",
      name: "lia_other",
    });
    expect(mismatch.status).toBe(400);
    const ok = await post(hono, `/hooks/unipile/auth?state=${state}`, {
      status: "CREATION_SUCCESS",
      account_id: "acct_z",
      name: s.account.id,
    });
    expect(ok.status).toBe(200);
    const [account] = await s.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, s.account.id));
    expect(account).toMatchObject({ status: "active", external_account_id: "acct_z" });
    const again = await post(hono, `/hooks/unipile/auth?state=${state}`, {
      status: "CREATION_SUCCESS",
      account_id: "acct_z",
    });
    expect(await again.json()).toMatchObject({ ok: true, already: true });

    const expired = encodeAuthState(s.ctx.vault, {
      ws: s.ctx.workspace.id,
      acc: s.account.id,
      exp: new Date(NOW).getTime() - 1,
    });
    expect(
      (await post(hono, `/hooks/unipile/auth?state=${expired}`, { account_id: "a" })).status,
    ).toBe(400);
  });

  it("refuses to link a LinkedIn account that another workspace uses", async () => {
    const s = await setup({ account: { status: "pending", external_account_id: null } });
    const other = await createTestContext({ db, now: NOW });
    await seedLinkedInAccount(other, { provider: "unipile", external_account_id: "acct_shared" });
    const hono = await app("s3cret", s);
    const state = encodeAuthState(s.ctx.vault, {
      ws: s.ctx.workspace.id,
      acc: s.account.id,
      exp: new Date(NOW).getTime() + 60_000,
    });
    const response = await post(hono, `/hooks/unipile/auth?state=${state}`, {
      status: "CREATION_SUCCESS",
      account_id: "acct_shared",
      name: s.account.id,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: "connected_in_another_workspace",
    });
    const [account] = await s.ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, s.account.id));
    expect(account).toMatchObject({
      status: "disconnected",
      external_account_id: null,
      status_reason: LINKED_ELSEWHERE_REASON,
    });
  });
});
