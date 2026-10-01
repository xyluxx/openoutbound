import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "../../core/engine.js";
import { companies, crm_webhooks } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedApiKey, seedCompany } from "../../testing/factories.js";
import { createCrmWebhook, crmWebhookRoute, findCrmWebhook, hashCrmToken } from "./crm-webhook.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DOMAIN = "harbor-dental.example.com";

async function setup() {
  const ctx = await createTestContext({ db: testDb });
  const company = await seedCompany(ctx, { name: "Harbor Dental", domain: DOMAIN });
  return { ctx, company };
}

function tokenOf(url: string): string {
  return url.split("/").pop() ?? "";
}

async function appFor(ctx: TestContext, engineOverrides: Partial<Engine> = {}) {
  const app = new Hono();
  const engine = {
    db: ctx.db,
    log: ctx.log,
    systemContext: async () => ctx,
    ...engineOverrides,
  } as unknown as Engine;
  crmWebhookRoute(app, { engine });
  const created = await createCrmWebhook.handler(ctx, { rotate: true });
  const token = tokenOf(created.url);
  const post = (body: string, path = `/hooks/crm/${token}`) =>
    app.request(path, { method: "POST", body, headers: { "content-type": "application/json" } });
  return { post, token };
}

async function companyStatus(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(companies).where(eq(companies.id, id));
  return row?.status;
}

async function hookRow(ctx: TestContext) {
  const [row] = await ctx.db
    .select()
    .from(crm_webhooks)
    .where(eq(crm_webhooks.workspace_id, ctx.workspace.id));
  return row;
}

describe("crm.create_webhook", () => {
  it("creates one secret URL, stores only its hash, and rotates on request", async () => {
    const { ctx } = await setup();
    const created = await createCrmWebhook.handler(ctx, { rotate: false });
    expect(created).toMatchObject({ rotated: false, created_at: ctx.clock.now() });
    expect(created.url).toMatch(/^http:\/\/localhost:7331\/hooks\/crm\/crmh_[A-Za-z0-9_-]{32}$/);
    const token = tokenOf(created.url);
    expect(created.token_hint).toBe(token.slice(-4));
    const row = await hookRow(ctx);
    expect(row).toMatchObject({ token_hash: hashCrmToken(token), token_hint: created.token_hint });
    expect(JSON.stringify(row)).not.toContain(token);
    expect((await findCrmWebhook(ctx.db, token))?.workspace_id).toBe(ctx.workspace.id);

    await expect(createCrmWebhook.handler(ctx, { rotate: false })).rejects.toMatchObject({
      code: "conflict",
      details: { token_hint: created.token_hint },
    });

    const rotated = await createCrmWebhook.handler(ctx, { rotate: true });
    expect(rotated.rotated).toBe(true);
    expect(await findCrmWebhook(ctx.db, token)).toBeNull();
    expect(await findCrmWebhook(ctx.db, tokenOf(rotated.url))).not.toBeNull();
    expect(await findCrmWebhook(ctx.db, "not-a-token")).toBeNull();
  });
});

describe("POST /hooks/crm/:token", () => {
  it("records the facts, stamps last_used_at and writes an audit entry", async () => {
    const { ctx, company } = await setup();
    const { post } = await appFor(ctx);
    const response = await post(
      JSON.stringify({ crm: "hubspot", facts: [{ fact: "customer", domain: DOMAIN }] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      dry_run: false,
      crm: "hubspot",
      results: [{ company_id: company.id, changed: true }],
      summary: { facts: 1, changed: 1 },
    });
    expect(await companyStatus(ctx, company.id)).toBe("customer");
    expect((await hookRow(ctx))?.last_used_at).toEqual(ctx.clock.now());
    expect(ctx.recorded.audit).toEqual([
      expect.objectContaining({
        operation: "crm.webhook",
        status: "ok",
        summary: "1 of 1 CRM facts from hubspot changed something",
      }),
    ]);
    expect(ctx.emitted("crm.fact_recorded")).toHaveLength(1);
  });

  it("refuses a URL whose creating key was revoked and changes nothing", async () => {
    const base = await createTestContext({ db: testDb });
    const key = await seedApiKey(base.db, { revoked_at: base.clock.now() });
    const ctx = base.with({
      principal: { ...base.principal, type: "agent", id: key.id, name: key.name },
    });
    const company = await seedCompany(ctx, { name: "Harbor Dental", domain: DOMAIN });
    const { post } = await appFor(ctx);
    const response = await post(
      JSON.stringify({ crm: "hubspot", facts: [{ fact: "customer", domain: DOMAIN }] }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "Unknown CRM webhook URL." });
    expect(await companyStatus(ctx, company.id)).toBe("active");
  });

  it("refuses a workspace that is archived and changes nothing", async () => {
    const ctx = await createTestContext({ db: testDb, workspace: { status: "archived" } });
    const company = await seedCompany(ctx, { name: "Harbor Dental", domain: DOMAIN });
    const { post } = await appFor(ctx);
    const response = await post(
      JSON.stringify({ crm: "hubspot", facts: [{ fact: "customer", domain: DOMAIN }] }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "This workspace is archived." });
    expect(await companyStatus(ctx, company.id)).toBe("active");
    expect(ctx.recorded.audit).toEqual([]);
  });

  it("previews with dry_run and changes nothing", async () => {
    const { ctx, company } = await setup();
    const { post } = await appFor(ctx);
    const response = await post(
      JSON.stringify({
        crm: "pipedrive",
        dry_run: true,
        facts: [{ fact: "do_not_contact", domain: DOMAIN }],
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      dry_run: true,
      results: [{ effects: expect.arrayContaining(["company status do_not_contact"]) }],
    });
    expect(await companyStatus(ctx, company.id)).toBe("active");
    expect((await hookRow(ctx))?.last_used_at).toBeNull();
    expect(ctx.recorded.audit).toEqual([]);
    expect(ctx.recorded.events).toEqual([]);
  });

  it("refuses unknown URLs, bad JSON, bad bodies and oversized bodies", async () => {
    const { ctx } = await setup();
    const { post, token } = await appFor(ctx);
    const valid = JSON.stringify({ crm: "hubspot", facts: [{ fact: "customer", domain: DOMAIN }] });

    const unknown = await post(valid, `/hooks/crm/crmh_${"x".repeat(32)}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "not_found" });
    expect((await post(valid, "/hooks/crm/nope")).status).toBe(404);

    const notJson = await post("{ not json");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid_json" });

    for (const body of [
      { crm: "hubspot", facts: [] },
      { crm: "hubspot", facts: [{ fact: "vip", domain: DOMAIN }] },
      { facts: [{ fact: "customer", domain: DOMAIN }] },
      {
        crm: "hubspot",
        facts: Array.from({ length: 501 }, () => ({ fact: "customer", domain: DOMAIN })),
      },
    ]) {
      const response = await post(JSON.stringify(body));
      expect(response.status).toBe(400);
      const answer = (await response.json()) as { error: string; message: string; hint: string };
      expect(answer.error).toBe("invalid_body");
      expect(answer.message.length).toBeGreaterThan(0);
      expect(answer.hint).toContain("1 to 500 facts");
    }

    const huge = JSON.stringify({
      crm: "hubspot",
      facts: [{ fact: "customer", domain: DOMAIN, note: "x".repeat(600 * 1024) }],
    });
    const tooLarge = await post(huge);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: "too_large" });
    expect(token).toMatch(/^crmh_/);
    expect(ctx.recorded.events).toEqual([]);
  });

  it("answers 500 without details when recording fails", async () => {
    const { ctx } = await setup();
    const { post } = await appFor(ctx, {
      systemContext: async () => {
        throw new Error("database is down");
      },
    } as Partial<Engine>);
    const response = await post(
      JSON.stringify({ crm: "hubspot", facts: [{ fact: "customer", domain: DOMAIN }] }),
    );
    expect(response.status).toBe(500);
    const answer = await response.json();
    expect(answer).toEqual({
      error: "internal",
      message: "The facts could not be recorded; please retry.",
    });
  });
});
