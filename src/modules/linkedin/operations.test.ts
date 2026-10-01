import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { linkedin_accounts, messages } from "../../db/schema/index.js";
import type { LinkedInProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount, seedMessage, seedPerson } from "../../testing/factories.js";
import { bumpCounter } from "./capacity.js";
import { decodeAuthState } from "./hosted-auth.js";
import { manageLinkedIn, module } from "./index.js";
import {
  connectAccount,
  listAccounts,
  listRelations,
  pauseAccount,
  removeAccount,
  resumeAccount,
  syncAccounts,
  updateAccount,
} from "./operations.js";
import { upsertRelation } from "./relations.js";

vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

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
    createAuthLink: vi.fn(async (_options: { state: string; notifyUrl?: string }) => ({
      url: "https://account.unipile.example.com/link/abc",
      expiresAt: "2026-09-23T15:00:00.000Z",
    })),
    listAccounts: vi.fn(async () => [
      {
        external_account_id: "acct_existing",
        name: "Dana Reyes",
        status: "active" as const,
        premium: true,
      },
    ]),
  } satisfies LinkedInProvider;
}

async function context(over: Parameters<typeof createTestContext>[0] = {}) {
  const provider = fakeProvider();
  const ctx = await createTestContext({ db, now: NOW, providers: { linkedin: provider }, ...over });
  return { ctx, provider };
}

/** Runs an operation handler and parses its output like the executor does. */
async function call<I, O extends z.ZodType>(
  op: { handler(ctx: TestContext, input: I): Promise<unknown>; output: O; input: z.ZodType<I> },
  ctx: TestContext,
  input: unknown,
): Promise<z.output<O>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input)));
}

describe("module registration", () => {
  it("exposes manage_linkedin actions for every operation and the sync schedule", () => {
    const ids = new Set(module.operations?.map((op) => op.id));
    for (const id of Object.values(manageLinkedIn.actions ?? {})) expect(ids.has(id)).toBe(true);
    expect(module.schedules?.[0]).toMatchObject({ cron: "*/15 * * * *", perWorkspace: true });
    expect(module.jobs?.map((job) => job.name)).toEqual([
      "linkedin.action",
      "linkedin.sync_workspace",
      "linkedin.sync",
      "linkedin.webhook_event",
    ]);
  });
});

describe("linkedin.accounts.connect", () => {
  it("requires the human's acceptance of the risk", async () => {
    const { ctx } = await context();
    await expect(call(connectAccount, ctx, { accept_risk: false })).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("accept_risk"),
    });
  });

  it("creates a pending account and a hosted login link", async () => {
    const { ctx, provider } = await context();
    const result = await call(connectAccount, ctx, {
      accept_risk: true,
      name: "Dana Reyes",
      timezone: "America/Chicago",
    });
    expect(result.auth_url).toBe("https://account.unipile.example.com/link/abc");
    expect(result.account).toMatchObject({
      status: "pending",
      name: "Dana Reyes",
      provider: "unipile",
    });
    const options = provider.createAuthLink.mock.calls[0]?.[0];
    expect(options?.state).toBe(result.account.id);
    const token = new URL(options?.notifyUrl ?? "").searchParams.get("state") ?? "";
    expect(decodeAuthState(ctx.vault, token, new Date(NOW))).toMatchObject({
      ws: ctx.workspace.id,
      acc: result.account.id,
    });
    const [row] = await ctx.db
      .select()
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, result.account.id));
    expect(row?.sync_state.pending_auth?.known_account_ids).toEqual(["acct_existing"]);
    expect(row?.ramp).toMatchObject({ enabled: true, start: 40 });
  });

  it("links an account that already exists at the provider", async () => {
    const { ctx } = await context();
    const result = await call(connectAccount, ctx, {
      accept_risk: true,
      external_account_id: "acct_existing",
    });
    expect(result.auth_url).toBeNull();
    expect(result.account).toMatchObject({
      status: "active",
      name: "Dana Reyes",
      premium: true,
      ramp: { enabled: true, week: 1, percent: 40 },
    });
    expect(ctx.enqueued("linkedin.sync")).toHaveLength(1);
    await expect(
      call(connectAccount, ctx, { accept_risk: true, external_account_id: "acct_existing" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      call(connectAccount, ctx, { accept_risk: true, external_account_id: "acct_missing" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses an account another workspace already uses", async () => {
    const { ctx } = await context();
    const other = await createTestContext({ db, now: NOW });
    await seedLinkedInAccount(other, { provider: "unipile", external_account_id: "acct_shared" });
    await expect(
      call(connectAccount, ctx, { accept_risk: true, external_account_id: "acct_shared" }),
    ).rejects.toMatchObject({ code: "conflict", details: { field: "external_account_id" } });
  });

  it("rejects unknown timezones", async () => {
    const { ctx } = await context();
    await expect(
      call(connectAccount, ctx, { accept_risk: true, timezone: "Mars/Olympus" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("linkedin.accounts.update", () => {
  it("warns when limits go above the safe defaults", async () => {
    const { ctx } = await context();
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    const result = await call(updateAccount, ctx, {
      account_id: account.id,
      limits: { invites_per_day: 25, messages_per_day: 20, invite_notes_per_month: 5 },
      working_hours: { start_hour: 8, end_hour: 21, days: [1, 2, 3, 4, 5, 6] },
    });
    expect(result.account.limits).toMatchObject({
      invites_per_day: 25,
      messages_per_day: 20,
      invite_notes_per_month: 5,
    });
    expect(result.warnings.join(" ")).toContain("invites_per_day = 25");
    expect(result.warnings.join(" ")).toContain("invite_notes_per_month");
    expect(result.warnings.join(" ")).toContain("Weekend");
    expect(result.warnings.join(" ")).toContain("07:00-20:00");
    expect(result.warnings.join(" ")).not.toContain("messages_per_day");
  });

  it("validates hours and restarts the ramp on request", async () => {
    const { ctx } = await context();
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    await expect(
      call(updateAccount, ctx, {
        account_id: account.id,
        working_hours: { start_hour: 18, end_hour: 9 },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    const result = await call(updateAccount, ctx, { account_id: account.id, ramp: "restart" });
    expect(result.account.ramp).toEqual({ enabled: true, week: 1, percent: 40 });
    expect(result.account.today.caps.invite).toBe(6);
    const off = await call(updateAccount, ctx, { account_id: account.id, ramp: "off" });
    expect(off.warnings).toHaveLength(1);
    expect(off.account.today.caps.invite).toBe(15);
  });
});

describe("pause, resume, remove", () => {
  it("pauses the queue and resumes it with fresh slots", async () => {
    const { ctx } = await context();
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    const person = await seedPerson(ctx);
    const queued = await seedMessage(ctx, {
      channel: "linkedin",
      action: "visit",
      status: "scheduled",
      linkedin_account_id: account.id,
      person_id: person.id,
      scheduled_for: new Date(NOW),
    });
    const paused = await call(pauseAccount, ctx.with({ request: { reason: "Holiday" } }), {
      account_id: account.id,
    });
    expect(paused).toMatchObject({
      actions_paused: 1,
      account: { status: "paused", status_reason: "Holiday" },
    });
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, queued.id));
    expect(row?.status).toBe("approved");

    const resumed = await call(resumeAccount, ctx, { account_id: account.id });
    expect(resumed).toMatchObject({ actions_requeued: 1, account: { status: "active" } });
    expect(ctx.enqueued("linkedin.action")).toHaveLength(1);
  });

  it("lets only humans resume a restricted account and restarts its ramp", async () => {
    const { ctx } = await context();
    const account = await seedLinkedInAccount(ctx, { provider: "unipile", status: "restricted" });
    const agent = ctx.with({ principal: { type: "agent", id: "key_agent", name: "Agent" } });
    await expect(call(resumeAccount, agent, { account_id: account.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    const result = await call(resumeAccount, ctx, { account_id: account.id });
    expect(result.account).toMatchObject({ status: "active", ramp: { week: 1, percent: 40 } });
    expect(result.warnings[0]).toContain("ramp restarted");
  });

  it("removes an account (dry run first) and cancels its queued actions", async () => {
    const { ctx } = await context();
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    const person = await seedPerson(ctx);
    await seedMessage(ctx, {
      channel: "linkedin",
      action: "visit",
      status: "approved",
      linkedin_account_id: account.id,
      person_id: person.id,
    });
    const preview = await call(removeAccount, ctx.with({ request: { dryRun: true } }), {
      account_id: account.id,
    });
    expect(preview).toMatchObject({ dry_run: true, preview: { actions_to_cancel: 1 } });
    const removed = await call(removeAccount, ctx, { account_id: account.id });
    expect(removed).toEqual({ removed: true, account_id: account.id, actions_cancelled: 1 });
    await expect(call(pauseAccount, ctx, { account_id: account.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("list, sync, relations", () => {
  it("lists accounts with today's caps and usage, paginated", async () => {
    const { ctx } = await context();
    const first = await seedLinkedInAccount(ctx, { provider: "unipile" });
    await seedLinkedInAccount(ctx, { provider: "unipile" });
    await bumpCounter(ctx.db, first.id, "2026-09-22", "invite", 4);
    const page = await call(listAccounts, ctx, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.has_more).toBe(true);
    expect(page.items[0]).toMatchObject({
      id: first.id,
      timezone: "America/Chicago",
      today: { used: { invite: 4 }, caps: { invite: 15 }, invites_week_cap: 80 },
      working_hours: { start_hour: 9, end_hour: 18 },
    });
    const next = await call(listAccounts, ctx, { limit: 1, cursor: page.next_cursor ?? undefined });
    expect(next.items[0]?.id).not.toBe(first.id);
    expect(next.has_more).toBe(false);
  });

  it("enqueues syncs for one account or the workspace", async () => {
    const { ctx } = await context();
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    expect(await call(syncAccounts, ctx, { account_id: account.id })).toMatchObject({
      status: "queued",
    });
    await call(syncAccounts, ctx, {});
    expect(ctx.enqueued("linkedin.sync")[0]?.payload).toEqual({ account_id: account.id });
    expect(ctx.enqueued("linkedin.sync_workspace")).toHaveLength(1);
  });

  it("lists relations by status with a cursor", async () => {
    const { ctx } = await context();
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    for (const status of ["invited", "connected", "connected"] as const) {
      const person = await seedPerson(ctx);
      await upsertRelation(ctx.db, {
        workspaceId: ctx.workspace.id,
        accountId: account.id,
        personId: person.id,
        status,
      });
    }
    const connected = await call(listRelations, ctx, { status: ["connected"], limit: 1 });
    expect(connected.items).toHaveLength(1);
    expect(connected.items[0]).toMatchObject({ status: "connected", account_id: account.id });
    const rest = await call(listRelations, ctx, {
      status: ["connected"],
      limit: 5,
      cursor: connected.next_cursor ?? undefined,
    });
    expect(rest.items).toHaveLength(1);
    expect(rest.items[0]?.person_id).not.toBe(connected.items[0]?.person_id);
  });
});
