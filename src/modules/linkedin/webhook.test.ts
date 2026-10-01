import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../core/engine.js";
import { silentLogger } from "../../core/logger.js";
import type { LinkedInProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount } from "../../testing/factories.js";
import { encodeAuthState } from "./hosted-auth.js";
import { unipileRoutes, webhookOwner } from "./webhook.js";

const NOW = "2026-09-22T15:00:00.000Z";
const SECRET = "s3cret";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

function provider(): LinkedInProvider {
  return {
    id: "unipile",
    parseWebhook: vi.fn(async (body: unknown) => {
      const events = (body as { events?: unknown[] }).events ?? [];
      return events as Awaited<ReturnType<NonNullable<LinkedInProvider["parseWebhook"]>>>;
    }),
  } as unknown as LinkedInProvider;
}

async function workspace(): Promise<TestContext> {
  return createTestContext({ db, now: NOW, providers: { linkedin: provider() } });
}

function routes(contexts: TestContext[]): Hono {
  const engine = {
    config: { ...contexts[0]?.config, env: { UNIPILE_WEBHOOK_SECRET: SECRET } },
    db: contexts[0]?.db,
    log: silentLogger(),
    systemContext: async (workspaceId: string | null) => {
      // The hosted login reads its state with the instance context first.
      if (workspaceId === null) return contexts[0];
      const ctx = contexts.find((candidate) => candidate.workspace.id === workspaceId);
      if (!ctx) throw new Error(`no context for ${workspaceId}`);
      return ctx;
    },
  } as unknown as Engine;
  const hono = new Hono();
  unipileRoutes(hono, { engine });
  return hono;
}

const message = (externalId: string) => ({
  account_id: externalId,
  events: [
    {
      type: "message_received",
      account_id: externalId,
      message: {
        id: "in_1",
        chat_id: "chat_9",
        sender_provider_id: "ACoAAlead",
        text: "Sounds interesting, tell me more.",
        sent_at: "2026-09-22T14:30:00Z",
        is_outbound: false,
      },
    },
  ],
});

async function post(hono: Hono, body: unknown) {
  const response = await hono.request("/hooks/unipile", {
    method: "POST",
    headers: { "content-type": "application/json", "x-openoutbound-secret": SECRET },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

describe("unipile webhook", () => {
  it("delivers an event only to the workspace that owns the account", async () => {
    const first = await workspace();
    const second = await workspace();
    const owner = await seedLinkedInAccount(first, {
      provider: "unipile",
      external_account_id: "acct_shared_1",
      created_at: new Date("2026-09-01T10:00:00Z"),
    });
    await seedLinkedInAccount(second, {
      provider: "unipile",
      external_account_id: "acct_shared_1",
      created_at: new Date("2026-09-10T10:00:00Z"),
    });
    expect(await post(routes([first, second]), message("acct_shared_1"))).toEqual({
      received: 1,
    });
    const delivered = first.enqueued("linkedin.webhook_event");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toMatchObject({ account_id: owner.id });
    expect(second.enqueued("linkedin.webhook_event")).toEqual([]);
  });

  it("sends the events of a disconnected row to the workspace where the account is connected", async () => {
    const left = await workspace();
    const current = await workspace();
    await seedLinkedInAccount(left, {
      provider: "unipile",
      external_account_id: "acct_shared_2",
      status: "disconnected",
      created_at: new Date("2026-09-01T10:00:00Z"),
    });
    const connected = await seedLinkedInAccount(current, {
      provider: "unipile",
      external_account_id: "acct_shared_2",
      created_at: new Date("2026-09-10T10:00:00Z"),
    });
    await post(routes([left, current]), message("acct_shared_2"));
    expect(left.enqueued("linkedin.webhook_event")).toEqual([]);
    expect(current.enqueued("linkedin.webhook_event")[0]?.payload).toMatchObject({
      account_id: connected.id,
    });
  });

  it("ignores events for an archived workspace", async () => {
    const archived = await createTestContext({
      db,
      now: NOW,
      providers: { linkedin: provider() },
      workspace: { status: "archived" },
    });
    await seedLinkedInAccount(archived, {
      provider: "unipile",
      external_account_id: "acct_archived",
    });
    expect(await post(routes([archived]), message("acct_archived"))).toEqual({
      received: 0,
      ignored: "workspace_archived",
    });
    expect(archived.enqueued("linkedin.webhook_event")).toEqual([]);
  });

  it("records the hosted login in the audit log", async () => {
    const ctx = await workspace();
    const pending = await seedLinkedInAccount(ctx, {
      provider: "unipile",
      status: "pending",
      external_account_id: null,
    });
    const state = encodeAuthState(ctx.vault, {
      ws: ctx.workspace.id,
      acc: pending.id,
      exp: new Date(NOW).getTime() + 60_000,
    });
    const response = await routes([ctx]).request(`/hooks/unipile/auth?state=${state}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "CREATION_SUCCESS",
        account_id: "acct_new",
        name: pending.id,
      }),
    });
    expect(response.status).toBe(200);
    expect(ctx.recorded.audit).toEqual([
      expect.objectContaining({
        operation: "linkedin.accounts.hosted_auth",
        target: { type: "linkedin_account", id: pending.id },
      }),
    ]);
  });

  it("picks the owner by age, then by connection", () => {
    type Row = Parameters<typeof webhookOwner>[0][number];
    const row = (id: string, day: number, status: "active" | "disconnected") =>
      ({ id, status, created_at: new Date(`2026-09-0${day}T00:00:00Z`) }) as Row;
    expect(webhookOwner([])).toBeNull();
    expect(webhookOwner([row("lia_b", 2, "active"), row("lia_a", 1, "active")])?.id).toBe("lia_a");
    expect(webhookOwner([row("lia_a", 1, "disconnected"), row("lia_b", 2, "active")])?.id).toBe(
      "lia_b",
    );
    expect(
      webhookOwner([row("lia_b", 2, "disconnected"), row("lia_a", 1, "disconnected")])?.id,
    ).toBe("lia_a");
  });
});
