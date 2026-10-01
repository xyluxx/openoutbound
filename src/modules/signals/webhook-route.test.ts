import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PRINCIPAL } from "../../core/context.js";
import type { Engine } from "../../core/engine.js";
import { companies, signal_webhook_tokens, signals } from "../../db/schema/index.js";
import type { SignalProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedApiKey, seedCompany, seedPerson } from "../../testing/factories.js";
import { signalsWebhookRoute, WEBHOOK_MAX_BYTES } from "./webhook-route.js";
import {
  createRateLimiter,
  createWebhookToken,
  findActiveToken,
  type RateLimiter,
} from "./webhook-tokens.js";

let ctx: TestContext;
let token: string;
let limiter: RateLimiter;

function app(): Hono {
  const engine = {
    db: ctx.db,
    log: ctx.log,
    systemContext: async () => ctx.with({ principal: { ...SYSTEM_PRINCIPAL, via: "http" } }),
  } as unknown as Engine;
  const hono = new Hono();
  signalsWebhookRoute({ limiter })(hono, { engine });
  return hono;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app().request(path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const signal = (overrides: Record<string, unknown> = {}) => ({
  key: "funding_round",
  company: { domain: "northwind.example.com", name: "Northwind Example" },
  title: "Raised a Series A",
  evidence_url: "https://news.example.org/northwind-series-a",
  occurred_at: "2026-09-18T00:00:00Z",
  strength: 0.9,
  ...overrides,
});

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  limiter = createRateLimiter({ capacity: 100 });
  ({ token } = await createWebhookToken(ctx.db, { workspaceId: ctx.workspace.id, name: "crm" }));
});

describe("POST /hooks/signals/:token", () => {
  it("rejects unknown and revoked tokens", async () => {
    expect((await post("/hooks/signals/oosig_unknown", { signals: [signal()] })).status).toBe(401);
    expect((await post("/hooks/signals/nope", { signals: [signal()] })).status).toBe(401);
    await ctx.db
      .update(signal_webhook_tokens)
      .set({ revoked_at: ctx.clock.now() })
      .where(eq(signal_webhook_tokens.workspace_id, ctx.workspace.id));
    const response = await post(`/hooks/signals/${token}`, { signals: [signal()] });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });

  it("rejects a token whose creating key was revoked", async () => {
    const key = await seedApiKey(ctx.db, { revoked_at: ctx.clock.now() });
    const made = await createWebhookToken(ctx.db, {
      workspaceId: ctx.workspace.id,
      name: "agent-made",
      createdBy: { type: "agent", id: key.id, name: key.name },
    });
    const response = await post(`/hooks/signals/${made.token}`, { signals: [signal()] });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });

  it("creates the company from its domain, stores the signal and dedupes a replay", async () => {
    const body = { signals: [signal()] };
    const first = await post(`/hooks/signals/${token}`, body);
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result).toMatchObject({ received: 1, created: 1, companies_created: 1, skipped: 0 });
    const [company] = await ctx.db
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, ctx.workspace.id),
          eq(companies.domain, "northwind.example.com"),
        ),
      );
    expect(company?.name).toBe("Northwind Example");
    expect(company?.intent_score).toBeGreaterThan(0);
    expect(ctx.emitted("signal.detected")).toHaveLength(1);

    const replay = await (await post(`/hooks/signals/${token}`, body)).json();
    expect(replay).toMatchObject({ created: 0, duplicates: 1, companies_created: 0 });
    const row = await findActiveToken(ctx.db, token);
    expect(row?.last_used_at).toBeInstanceOf(Date);
  });

  it("maps to existing people and companies and reports bad items one by one", async () => {
    const company = await seedCompany(ctx);
    const person = await seedPerson(ctx, { company_id: company.id });
    const response = await post(`/hooks/signals/${token}`, {
      signals: [
        signal({
          key: "engagement_with_us",
          company: undefined,
          person: { email: person.email },
          title: "Visited the pricing page twice",
          evidence_url: "https://app.example.org/visits/123",
        }),
        signal({ key: "not_a_known_key" }),
        signal({ evidence_url: "" }),
        signal({ company: { name: "Nobody Example" } }),
      ],
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      created: number;
      skipped: number;
      items: Array<{ index: number; status: string; person_id?: string; reason?: string }>;
    };
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(3);
    expect(result.items[0]).toMatchObject({ index: 0, status: "created", person_id: person.id });
    expect(result.items[1]?.reason).toContain("Unknown signal key");
    expect(result.items[2]?.status).toBe("skipped");
    expect(result.items[3]?.reason).toContain("No company or person");
  });

  it("answers 400 for invalid JSON, 422 for a wrong envelope and 413 for large bodies", async () => {
    expect((await post(`/hooks/signals/${token}`, "{not json")).status).toBe(400);
    const wrong = await post(`/hooks/signals/${token}`, { items: [] });
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ code: "validation_failed" });
    const large = await post(`/hooks/signals/${token}`, "x".repeat(WEBHOOK_MAX_BYTES + 10));
    expect(large.status).toBe(413);
  });

  it("rate limits per token", async () => {
    limiter = createRateLimiter({ capacity: 1, perSeconds: 60 });
    const hono = app();
    const send = () =>
      hono.request(`/hooks/signals/${token}`, {
        method: "POST",
        body: JSON.stringify({ signals: [signal()] }),
      });
    expect((await send()).status).toBe(200);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("reads provider payloads with ?provider= and never credits the old company", async () => {
    const oldCompany = await seedCompany(ctx);
    const person = await seedPerson(ctx, {
      company_id: oldCompany.id,
      linkedin_url: "https://www.linkedin.com/in/jordan-example",
    });
    expect((await post(`/hooks/signals/${token}?provider=crustdata`, {})).status).toBe(404);

    const provider: SignalProvider = {
      id: "crustdata",
      supportedSignals: ["job_change"],
      collect: async () => [],
      parseWebhook: async () => [
        {
          definition_key: "job_change",
          title: "Jordan Example started as VP Sales at Globex Example",
          evidence_url: "https://www.linkedin.com/in/jordan-example",
          source: "crustdata",
          strength: 0.6,
          person: { linkedin_url: "https://www.linkedin.com/in/jordan-example" },
          company: { name: "Globex Example" },
        },
      ],
    };
    ctx.providers.set("signals", provider);
    const response = await post(`/hooks/signals/${token}?provider=crustdata`, { results: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: 1 });
    const [stored] = await ctx.db
      .select()
      .from(signals)
      .where(and(eq(signals.workspace_id, ctx.workspace.id), eq(signals.person_id, person.id)));
    expect(stored?.definition_key).toBe("job_change");
    expect(stored?.company_id).toBeNull();
    ctx.providers.set("signals", null);
  });

  it("leaves one audit entry per accepted request", async () => {
    const before = ctx.recorded.audit.length;
    const response = await post(`/hooks/signals/${token}`, {
      signals: [
        signal({
          company: { domain: "harbor-audit.example.com", name: "Harbor Audit Example" },
          evidence_url: "https://news.example.org/harbor-audit",
        }),
      ],
    });
    expect(response.status).toBe(200);
    expect(ctx.recorded.audit.slice(before)).toEqual([
      expect.objectContaining({
        operation: "signals.webhook",
        status: "ok",
        target: expect.objectContaining({ type: "signal_webhook_token" }),
      }),
    ]);
  });
});
