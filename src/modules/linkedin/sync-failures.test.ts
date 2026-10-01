/**
 * LinkedIn sync when the provider stops early or fails: a listing that ends with a cursor keeps
 * its place and does not move synced_at past what was not seen, a stored cursor the provider
 * rejects is dropped, a failure is stored with its class on the account and the run result, one
 * failed listing does not stop the other, a lost LinkedIn session disconnects the account, a
 * rejected Unipile key or a paused provider leaves it active with the error, and 5 failed syncs
 * in a row open a problem that a clean sync resolves.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { providerFailure } from "../../core/failures.js";
import { linkedin_accounts, problems } from "../../db/schema/index.js";
import { createUnipileLinkedIn } from "../../providers/linkedin/unipile.js";
import { createUnipileClient } from "../../providers/linkedin/unipile-client.js";
import type { LinkedInInboundMessage, LinkedInProvider } from "../../providers/types.js";
import { createTestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount } from "../../testing/factories.js";
import { createFakeFetch } from "../../testing/fake-fetch.js";
import { removeAccount } from "./operations.js";
import { toAccountOutput } from "./outputs.js";
import { syncAccount } from "./sync.js";

vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

const NOW = "2026-09-22T15:00:00.000Z";
const LAST_SYNC = "2026-09-22T14:45:00.000Z";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

type Messages = { messages: LinkedInInboundMessage[]; cursor?: string | null };
type Relations = Awaited<ReturnType<NonNullable<LinkedInProvider["syncRelations"]>>>;
type SyncOptions = { since?: Date; cursor?: string | null };

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
    syncRelations: vi.fn(
      async (_account: string, _options: SyncOptions): Promise<Relations> => ({ connections: [] }),
    ),
    syncMessages: vi.fn(
      async (_account: string, _options: SyncOptions): Promise<Messages> => ({ messages: [] }),
    ),
  } satisfies LinkedInProvider;
}

async function setup() {
  const provider = fakeProvider();
  const ctx = await createTestContext({ db, now: NOW, providers: { linkedin: provider } });
  const account = await seedLinkedInAccount(ctx, {
    provider: "unipile",
    sync_state: { messages_synced_at: LAST_SYNC, relations_synced_at: LAST_SYNC },
  });
  const sync = () =>
    syncAccount(ctx.jobContext({ name: "linkedin.sync" }), ctx.workspace.id, account.id);
  const stored = async () => {
    const [row] = await ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, account.id));
    if (!row) throw new Error("account gone");
    return row;
  };
  return { ctx, provider, account, sync, stored };
}

const message = (id: string): LinkedInInboundMessage => ({
  id,
  chat_id: `chat_${id}`,
  sender_provider_id: "ACoAAstranger",
  text: "Hello",
  sent_at: "2026-09-22T14:50:00Z",
  is_outbound: false,
});

describe("a listing the provider did not finish", () => {
  it("keeps its cursor and synced_at until it ends, then moves synced_at to when it started", async () => {
    const s = await setup();
    s.provider.syncMessages
      .mockResolvedValueOnce({ messages: [message("a")], cursor: "page-2" })
      .mockResolvedValueOnce({ messages: [message("b")], cursor: null });

    await s.sync();
    expect((await s.stored()).sync_state).toMatchObject({
      messages_cursor: "page-2",
      messages_synced_at: LAST_SYNC,
      messages_cursor_started_at: NOW,
      relations_synced_at: NOW,
    });

    s.ctx.clock.advance(15 * 60_000);
    await s.sync();
    expect(s.provider.syncMessages.mock.calls[1]?.[1]).toMatchObject({ cursor: "page-2" });
    expect((await s.stored()).sync_state).toMatchObject({
      messages_cursor: null,
      messages_synced_at: NOW,
      messages_cursor_started_at: null,
    });
  });
});

describe("a listing that fails", () => {
  it("stores the failure, keeps its place, and still syncs the other listing", async () => {
    const s = await setup();
    s.provider.syncRelations.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "timeout" }),
    );
    s.provider.syncMessages.mockResolvedValue({ messages: [message("c")] });

    const result = await s.sync();
    expect(result).toMatchObject({
      unmatched: 1,
      failure: { class: "timeout", retryable: true, provider: "unipile" },
    });
    expect(s.provider.syncMessages).toHaveBeenCalledTimes(1);
    const state = (await s.stored()).sync_state;
    expect(state).toMatchObject({
      relations_synced_at: LAST_SYNC,
      messages_synced_at: NOW,
      last_error: { at: NOW, step: "relations", failure: { class: "timeout" } },
    });
    const view = await toAccountOutput(s.ctx, await s.stored(), s.ctx.workspace);
    expect(view.last_sync_error).toMatchObject({
      step: "relations",
      failure: { class: "timeout" },
    });

    // The next clean sync clears it.
    s.ctx.clock.advance(15 * 60_000);
    await s.sync();
    expect((await s.stored()).sync_state.last_error).toBeNull();
  });

  it("disconnects the account when LinkedIn rejects its session, and stops there", async () => {
    const s = await setup();
    s.provider.syncRelations.mockRejectedValue(
      providerFailure({
        provider: "unipile",
        class: "auth_invalid",
        scope: "call",
        upstreamStatus: 401,
        details: { disconnected: true },
      }),
    );
    const result = await s.sync();
    expect(result).toMatchObject({ failure: { class: "auth_invalid", scope: "call" } });
    expect(s.provider.syncMessages).not.toHaveBeenCalled();
    const row = await s.stored();
    expect(row.status).toBe("disconnected");
    expect(row.sync_state).toMatchObject({
      messages_synced_at: LAST_SYNC,
      relations_synced_at: LAST_SYNC,
      last_error: { step: "relations", failure: { class: "auth_invalid" } },
    });
  });

  it("leaves the account active when the provider is paused, and stops there", async () => {
    const s = await setup();
    s.provider.syncRelations.mockRejectedValue(
      providerFailure({
        provider: "unipile",
        class: "auth_invalid",
        retryable: false,
        message: "Unipile is paused for this workspace since 2026-09-22T14:00:00.000Z.",
        details: { paused: true },
      }),
    );
    const result = await s.sync();
    expect(result).toMatchObject({ failure: { class: "auth_invalid", scope: "account" } });
    expect(s.provider.syncMessages).not.toHaveBeenCalled();
    const row = await s.stored();
    expect(row).toMatchObject({ status: "active", status_reason: null });
    expect(row.sync_state.last_error).toMatchObject({
      step: "relations",
      failure: { class: "auth_invalid" },
    });
  });

  it("opens a problem after 5 failed syncs in a row, and a clean sync resolves it", async () => {
    const s = await setup();
    s.provider.syncMessages.mockRejectedValue(
      providerFailure({ provider: "unipile", class: "bad_request", upstreamStatus: 400 }),
    );
    const readProblems = () =>
      s.ctx.db
        .select()
        .from(problems)
        .where(
          and(
            eq(problems.workspace_id, s.ctx.workspace.id),
            eq(problems.dedupe_key, `mailbox_down:${s.account.id}:read`),
          ),
        );
    for (let n = 1; n < 5; n++) {
      await s.sync();
      s.ctx.clock.advance(15 * 60_000);
    }
    expect((await s.stored()).sync_state.failed_syncs).toBe(4);
    expect(await readProblems()).toEqual([]);

    await s.sync();
    expect(await readProblems()).toMatchObject([
      {
        status: "open",
        kind: "mailbox_down",
        severity: "high",
        owner: "person",
        title: `LinkedIn account ${s.account.name} cannot read replies`,
        subject_type: "linkedin_account",
        subject_id: s.account.id,
        data: { account_id: s.account.id, failed_syncs: 5, failure: { class: "bad_request" } },
      },
    ]);

    s.ctx.clock.advance(15 * 60_000);
    s.provider.syncMessages.mockResolvedValue({ messages: [] });
    await s.sync();
    expect((await s.stored()).sync_state).toMatchObject({ failed_syncs: 0, last_error: null });
    expect((await readProblems()).map((problem) => problem.status)).toEqual(["resolved"]);
  });

  it("resolves that problem when the account is removed", async () => {
    const s = await setup();
    s.provider.syncMessages.mockRejectedValue(
      providerFailure({ provider: "unipile", class: "malformed" }),
    );
    for (let n = 0; n < 5; n++) await s.sync();
    const key = `mailbox_down:${s.account.id}:read`;
    const statuses = async () =>
      (
        await s.ctx.db
          .select()
          .from(problems)
          .where(and(eq(problems.workspace_id, s.ctx.workspace.id), eq(problems.dedupe_key, key)))
      ).map((problem) => problem.status);
    expect(await statuses()).toEqual(["open"]);
    await removeAccount.handler(s.ctx, { account_id: s.account.id });
    expect(await statuses()).toEqual(["resolved"]);
  });

  it("stops after a rate limit of the account without moving anything", async () => {
    const s = await setup();
    s.provider.syncRelations.mockRejectedValue(
      providerFailure({ provider: "unipile", class: "rate_limited", retryAfterSeconds: 600 }),
    );
    const result = await s.sync();
    expect(result).toMatchObject({ failure: { class: "rate_limited", retry_after_s: 600 } });
    expect(s.provider.syncMessages).not.toHaveBeenCalled();
    expect((await s.stored()).sync_state).toMatchObject({
      messages_synced_at: LAST_SYNC,
      relations_synced_at: LAST_SYNC,
    });
  });
});

describe("a stored cursor Unipile no longer accepts (real client)", () => {
  it("is dropped, and the next sync lists again from synced_at", async () => {
    const fetch = createFakeFetch([
      {
        match: /\/users\/relations/,
        response: { json: { object: "UserRelationList", items: [] } },
      },
      { match: /\/messages/, response: { json: { object: "MessageList", items: [] } } },
      // Later routes win: the stored cursor is refused.
      {
        match: /\/messages\?.*cursor=stale-cursor/,
        response: {
          status: 400,
          json: { status: 400, type: "errors/invalid_parameters", title: "Invalid parameters" },
        },
      },
    ]);
    const client = createUnipileClient({
      dsn: "api9.unipile.example.com:13111",
      apiKey: "unipile-test-key-placeholder",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const ctx = await createTestContext({ db, now: NOW });
    ctx.providers.set("linkedin", createUnipileLinkedIn(client, ctx.clock));
    const account = await seedLinkedInAccount(ctx, {
      provider: "unipile",
      sync_state: {
        messages_synced_at: LAST_SYNC,
        relations_synced_at: LAST_SYNC,
        messages_cursor: "stale-cursor",
        messages_cursor_started_at: "2026-09-22T14:30:00.000Z",
      },
    });
    const sync = () =>
      syncAccount(ctx.jobContext({ name: "linkedin.sync" }), ctx.workspace.id, account.id);
    const stored = async () => {
      const [row] = await ctx.db
        .select()
        .from(linkedin_accounts)
        .where(eq(linkedin_accounts.id, account.id));
      return row?.sync_state;
    };
    const messageCalls = () =>
      fetch.calls
        .map((call) => new URL(call.url))
        .filter((url) => url.pathname.endsWith("/messages"));

    expect(await sync()).toMatchObject({ failure: { class: "bad_request" } });
    expect(await stored()).toMatchObject({
      messages_cursor: null,
      messages_cursor_started_at: null,
      messages_synced_at: LAST_SYNC,
      last_error: { step: "messages", failure: { class: "bad_request" } },
    });

    ctx.clock.advance(15 * 60_000);
    const next = await sync();
    expect(next).not.toHaveProperty("failure");
    const last = messageCalls().at(-1);
    expect(last?.searchParams.get("cursor")).toBeNull();
    expect(last?.searchParams.get("after")).toBe(
      new Date(Date.parse(LAST_SYNC) - 10 * 60_000).toISOString(),
    );
    expect(await stored()).toMatchObject({
      messages_cursor: null,
      messages_synced_at: ctx.clock.now().toISOString(),
      last_error: null,
    });
  });
});

describe("Unipile answers about the key or the session (real client)", () => {
  /** The account synced through the real Unipile client, answering 401 with `type`. */
  async function unipileSetup(type: string) {
    const fetch = createFakeFetch([
      {
        match: /\/users\/relations/,
        response: { status: 401, json: { status: 401, type, title: "Unauthorized" } },
      },
      { match: /\/messages/, response: { json: { object: "MessageList", items: [] } } },
    ]);
    const client = createUnipileClient({
      dsn: "api9.unipile.example.com:13111",
      apiKey: "unipile-test-key-placeholder",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const ctx = await createTestContext({ db, now: NOW });
    ctx.providers.set("linkedin", createUnipileLinkedIn(client, ctx.clock));
    const account = await seedLinkedInAccount(ctx, {
      provider: "unipile",
      sync_state: { messages_synced_at: LAST_SYNC, relations_synced_at: LAST_SYNC },
    });
    const result = await syncAccount(
      ctx.jobContext({ name: "linkedin.sync" }),
      ctx.workspace.id,
      account.id,
    );
    const [row] = await ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, account.id));
    const down = await ctx.db
      .select()
      .from(problems)
      .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "mailbox_down")));
    return { result, row, down, fetch };
  }

  it("leaves the account active with the error when the Unipile key is rejected", async () => {
    const { result, row, down, fetch } = await unipileSetup("errors/unauthorized");
    expect(result).toMatchObject({ failure: { class: "auth_invalid", scope: "account" } });
    expect(row).toMatchObject({ status: "active", status_reason: null });
    expect(row?.sync_state.last_error).toMatchObject({
      step: "relations",
      failure: { class: "auth_invalid", scope: "account" },
    });
    expect(down).toEqual([]);
    // A key problem stops the run: the messages listing is not asked.
    expect(fetch.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v1/users/relations",
    ]);
  });

  it("disconnects the account when LinkedIn ended its session", async () => {
    const { result, row, down } = await unipileSetup("errors/disconnected_account");
    expect(result).toMatchObject({ failure: { class: "auth_invalid", scope: "call" } });
    expect(row?.status).toBe("disconnected");
    expect(down).toMatchObject([{ status: "open", dedupe_key: `mailbox_down:${row?.id}` }]);
  });
});
