import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isOpenOutboundError } from "../../../core/errors.js";
import type { AnyOperation } from "../../../core/operation.js";
import {
  automation_rules,
  companies,
  lists,
  signal_definitions,
  signals,
} from "../../../db/schema/index.js";
import type { SignalProvider } from "../../../providers/types.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedCampaign, seedCompany, seedPerson } from "../../../testing/factories.js";
import { storeSignal } from "../service.js";
import {
  automationsCreate,
  automationsDelete,
  automationsList,
  automationsTest,
  automationsUpdate,
} from "./automations.js";
import {
  definitionsCreate,
  definitionsDelete,
  definitionsList,
  definitionsUpdate,
} from "./definitions.js";
import {
  monitorsCreate,
  monitorsDelete,
  monitorsList,
  monitorsRun,
  monitorsUpdate,
} from "./monitors.js";
import { signalsDismiss, signalsFeed, signalsGet, signalsIngest } from "./signals.js";
import { webhookTokensCreate, webhookTokensList, webhookTokensRevoke } from "./webhook-tokens.js";

vi.mock("../../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("../../research/service.js", () => ({
  requestResearch: vi.fn(async () => ({ jobIds: [], cachedBriefIds: [] })),
}));

let ctx: TestContext;

/** Runs an operation the way the executor does: parse input, handle, parse output. */
// biome-ignore lint/suspicious/noExplicitAny: test helper over heterogeneous operations
async function call(op: AnyOperation, input: unknown, context: TestContext = ctx): Promise<any> {
  const parsed = op.input.parse(input);
  return op.output.parse(await op.handler(context, parsed));
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isOpenOutboundError(error)) return error;
    throw error;
  }
  throw new Error("expected an OpenOutboundError");
}

let counter = 0;
async function signalFor(companyId: string, key = "funding_round", strength = 1, daysAgo = 0) {
  counter += 1;
  const occurred = new Date(ctx.clock.now().getTime() - daysAgo * 86_400_000);
  return storeSignal(ctx, {
    definition_key: key,
    title: `Signal ${counter}`,
    evidence_url: `https://news.example.org/story-${counter}`,
    source: "test",
    strength,
    occurred_at: occurred.toISOString(),
    companyId,
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => {
  ctx.recorded.jobs.length = 0;
  ctx.recorded.events.length = 0;
  ctx.recorded.approvals.length = 0;
  ctx.clock.set("2026-09-19T12:00:00Z");
});

describe("signals.feed, get, dismiss", () => {
  it("ranks by current score, paginates and names subjects", async () => {
    const company = await seedCompany(ctx);
    const strong = await signalFor(company.id, "funding_round", 1, 0);
    const weaker = await signalFor(company.id, "news_mention", 1, 0);
    const old = await signalFor(company.id, "website_change", 1, 200);
    const first = await call(signalsFeed, { company_id: company.id, limit: 1 });
    expect(first.items[0]).toMatchObject({
      id: strong.id,
      company_name: company.name,
      untrusted: true,
    });
    expect(first.has_more).toBe(true);
    const second = await call(signalsFeed, {
      company_id: company.id,
      limit: 1,
      cursor: first.next_cursor,
    });
    expect(second.items.map((item: { id: string }) => item.id)).toEqual([weaker.id]);
    expect(second.has_more).toBe(false);
    // The 200-day-old website change decayed below 1 and is hidden by default.
    const all = await call(signalsFeed, { company_id: company.id, min_score: 0 });
    expect(all.items.map((item: { id: string }) => item.id)).toContain(old.id);
    const recent = await call(signalsFeed, {
      company_id: company.id,
      sort: "recent",
      min_score: 0,
    });
    expect(recent.items).toHaveLength(3);
  });

  it("returns a signal with its automation history and dismisses signals", async () => {
    const company = await seedCompany(ctx);
    const stored = await signalFor(company.id);
    const detail = await call(signalsGet, { signal_id: stored.id });
    expect(detail).toMatchObject({
      id: stored.id,
      definition_name: expect.any(String),
      automations: [],
      used_message_ids: [],
    });
    const [before] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(before?.intent_score).toBeGreaterThan(0);

    const missing = "sig_01k6a3v0q8x3m2n4p5r6s7t8v9";
    const result = await call(signalsDismiss, { signal_ids: [stored.id, missing] });
    expect(result).toEqual({ dismissed: 1, not_found: [missing] });
    const [after] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(after?.intent_score).toBe(0);
    expect(await call(signalsDismiss, { signal_ids: [stored.id] })).toMatchObject({ dismissed: 0 });
    const dismissed = await call(signalsFeed, { company_id: company.id, status: "dismissed" });
    expect(dismissed.items).toHaveLength(1);
    expect((await failure(call(signalsGet, { signal_id: missing }))).code).toBe("not_found");
  });
});

describe("signals.ingest", () => {
  it("creates companies from domains, dedupes and reports bad items", async () => {
    const input = {
      signals: [
        {
          key: "funding_round",
          company: { domain: "ingest-one.example.com", name: "Ingest One Example" },
          title: "Raised a seed round",
          evidence_url: "https://news.example.org/ingest-one-seed",
        },
        {
          key: "unknown_key",
          company: { domain: "ingest-one.example.com" },
          title: "Nope",
          evidence_url: "https://news.example.org/nope",
        },
      ],
      source: "agent_research",
    };
    const result = await call(signalsIngest, input);
    expect(result).toMatchObject({ received: 2, created: 1, skipped: 1, companies_created: 1 });
    expect(result.items[1].reason).toContain("Unknown signal key");
    const again = await call(signalsIngest, input);
    expect(again).toMatchObject({ created: 0, duplicates: 1, companies_created: 0 });
    const [row] = await ctx.db
      .select()
      .from(signals)
      .where(eq(signals.id, result.items[0].signal_id));
    expect(row?.source).toBe("agent_research");

    const noCreate = await call(signalsIngest, {
      signals: [{ ...input.signals[0], company: { domain: "ingest-two.example.com" } }],
      create_companies: false,
    });
    expect(noCreate.items[0].reason).toContain("No company or person");
  });
});

describe("signal definitions", () => {
  it("lists the catalog, tunes a built-in and queues an intent recompute", async () => {
    const builtins = await call(definitionsList, { kind: "builtin", limit: 100 });
    expect(builtins.items).toHaveLength(15);
    expect(builtins.items[0].detection).toBeUndefined();
    const page = await call(definitionsList, { limit: 10 });
    expect(page.has_more).toBe(true);

    const updated = await call(definitionsUpdate, {
      key: "news_mention",
      weight: 10,
      keywords: ["partnership"],
      collectors: ["news_gdelt", "mystery_source"],
    });
    expect(updated.changed).toEqual(["weight", "collectors", "keywords"]);
    expect(updated.detection.keywords).toEqual(["partnership"]);
    expect(updated.warnings[0]).toContain("mystery_source");
    expect(ctx.enqueued("signals.recompute_intent")).toHaveLength(1);

    const same = await call(definitionsUpdate, { key: "news_mention", weight: 10 });
    expect(same.changed).toEqual([]);
    expect((await failure(call(definitionsUpdate, { key: "no_such_key" }))).code).toBe("not_found");
  });

  it("creates, conflicts and removes custom definitions", async () => {
    const created = await call(definitionsCreate, {
      key: "new_clinic_location",
      name: "Opened a new clinic location",
      description: "The practice opened an additional clinic location recently.",
      urls: ["/locations", "https://{domain}/news"],
    });
    expect(created).toMatchObject({
      kind: "custom",
      min_strength: 0.5,
      detection: {
        instructions: "The practice opened an additional clinic location recently.",
        collectors: ["website_changes", "news_gdelt", "rss"],
        tier: "fast",
      },
    });
    expect(
      (await failure(call(definitionsCreate, { ...created, key: "new_clinic_location" }))).code,
    ).toBe("conflict");
    expect(
      (
        await failure(
          call(definitionsCreate, {
            key: "funding_round",
            name: "Mine",
            description: "My own funding definition.",
          }),
        )
      ).code,
    ).toBe("conflict");
    expect((await failure(call(definitionsDelete, { key: "funding_round" }))).hint).toContain(
      "enabled false",
    );
    expect(await call(definitionsDelete, { key: "new_clinic_location" })).toEqual({
      key: "new_clinic_location",
      deleted: true,
    });
    expect(await call(definitionsDelete, { key: "new_clinic_location" })).toMatchObject({
      deleted: false,
    });
  });
});

describe("monitors", () => {
  const paid: SignalProvider = {
    id: "predictleads",
    supportedSignals: ["funding_round"],
    creditsPerCall: 4,
    collect: async () => [],
  };

  it("validates schedules and targets and estimates monthly credits", async () => {
    const company = await seedCompany(ctx);
    const base = { name: "Watch", target: { kind: "companies", company_ids: [company.id] } };
    expect((await failure(call(monitorsCreate, { ...base, schedule: "nonsense cron" }))).code).toBe(
      "validation_failed",
    );
    expect(
      (await failure(call(monitorsCreate, { ...base, schedule: "*/10 * * * *" }))).message,
    ).toContain("more than once per hour");
    expect(
      (
        await failure(
          call(monitorsCreate, {
            name: "Missing list",
            target: { kind: "list", list_id: "ls_01k6a3v0q8x3m2n4p5r6s7t8v9" },
          }),
        )
      ).code,
    ).toBe("not_found");

    ctx.providers.set("signals", paid);
    const created = await call(monitorsCreate, {
      ...base,
      collectors: ["job_boards", "predictleads", "crustdata"],
      schedule: "0 6 * * 1",
      signal_keys: ["funding_round", "made_up_key"],
      budget: { max_companies: 10, max_credits_per_month: 100 },
    });
    expect(created.warnings.join(" ")).toContain('"made_up_key" does not exist');
    expect(created.next_run_at).toBe("2026-09-21T06:00:00.000Z");
    expect(created.estimate).toMatchObject({
      companies_per_run: 10,
      paid_providers: ["predictleads", "crustdata"],
      credits_per_run: 50,
      credits_per_month: 100,
    });
    expect(created.warnings[0]).toContain('"crustdata" is not configured');
    ctx.providers.set("signals", null);
  });

  it("pauses, merges budgets, runs as a job with a dry run first and deletes", async () => {
    const company = await seedCompany(ctx, { fit_score: 90 });
    ctx.providers.set("signals", paid);
    const created = await call(monitorsCreate, {
      name: "One company",
      target: { kind: "companies", company_ids: [company.id] },
      collectors: ["predictleads"],
      budget: { max_credits_per_run: 3 },
    });
    const paused = await call(monitorsUpdate, {
      monitor_id: created.id,
      enabled: false,
      budget: { max_companies: 5 },
    });
    expect(paused).toMatchObject({
      enabled: false,
      next_run_at: null,
      budget: { max_companies: 5, max_credits_per_run: 3 },
    });

    const preview = await call(
      monitorsRun,
      { monitor_id: created.id },
      ctx.with({ request: { dryRun: true } }),
    );
    expect(preview).toMatchObject({
      dry_run: true,
      preview: { companies: 1, estimated_credits: 3 },
      estimated_cost: { credits: 3 },
    });
    expect(ctx.enqueued("monitors.run")).toHaveLength(0);

    const handle = await call(monitorsRun, { monitor_id: created.id });
    expect(handle.status).toBe("queued");
    const again = await call(monitorsRun, { monitor_id: created.id });
    expect(again.job_id).toBe(handle.job_id);
    expect(ctx.enqueued("monitors.run")[0]?.payload).toMatchObject({
      monitor_id: created.id,
      trigger: "manual",
    });

    const listed = await call(monitorsList, { enabled: false });
    expect(listed.items.map((item: { id: string }) => item.id)).toContain(created.id);
    expect(await call(monitorsDelete, { monitor_id: created.id })).toEqual({
      monitor_id: created.id,
      deleted: true,
    });
    expect((await failure(call(monitorsRun, { monitor_id: created.id }))).code).toBe("not_found");
    ctx.providers.set("signals", null);
  });

  it("shows the data budget in the run dry run and warns when the paid calls do not fit", async () => {
    const budgeted = await createTestContext({
      db: ctx.testDb,
      settings: { data: { monthly_credit_budget: 10 } },
    });
    await budgeted.usage.record({
      slot: "lead_source",
      provider: "apollo",
      operation: "leads.find_import",
      credits: 7,
    });
    budgeted.providers.set("signals", paid);
    const company = await seedCompany(budgeted, { fit_score: 90 });
    const created = await call(
      monitorsCreate,
      {
        name: "Budgeted",
        target: { kind: "companies", company_ids: [company.id] },
        collectors: ["job_boards", "predictleads"],
      },
      budgeted,
    );
    const preview = await call(
      monitorsRun,
      { monitor_id: created.id },
      budgeted.with({ request: { dryRun: true } }),
    );
    expect(preview).toMatchObject({
      dry_run: true,
      preview: {
        estimated_credits: 4,
        budget: { monthly_credits: 10, used_this_month: 7, left_this_month: 3 },
      },
      estimated_cost: { credits: 4 },
    });
    expect(preview.warnings).toEqual([
      "Not enough data budget: needs 4 credits, 3 left this month (7 of 10 used), so paid provider calls stop at the first one that does not fit (the free collectors still run). Check fewer companies (budget.max_companies) or cap the run (budget.max_credits_per_run), or ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    ]);

    // Free collectors only: nothing to pay for, and the budget is still shown.
    const free = await call(
      monitorsCreate,
      {
        name: "Free",
        target: { kind: "companies", company_ids: [company.id] },
        collectors: ["job_boards"],
      },
      budgeted,
    );
    expect(
      await call(
        monitorsRun,
        { monitor_id: free.id },
        budgeted.with({ request: { dryRun: true } }),
      ),
    ).toMatchObject({
      preview: { estimated_credits: 0, budget: { left_this_month: 3 } },
      warnings: [],
    });
  });
});

describe("automation rules", () => {
  it("creates rules with safe defaults, hides secrets and keeps them on update", async () => {
    const { campaign } = await seedCampaign(ctx, { status: "draft" });
    const created = await call(automationsCreate, {
      name: "Champion moved",
      filters: { definition_keys: ["job_change", "not_a_key"] },
      actions: [
        { type: "enroll", campaign_id: campaign.id },
        {
          type: "webhook",
          url: "https://hooks.example.org/in",
          secret: "a-very-long-signing-secret",
        },
      ],
    });
    expect(created.require_approval).toBe(true);
    expect(created.actions[1]).toEqual({
      type: "webhook",
      url: "https://hooks.example.org/in",
      signed: true,
    });
    expect(JSON.stringify(created)).not.toContain("a-very-long-signing-secret");
    expect(created.warnings.join(" ")).toContain("not_a_key");
    expect(created.warnings.join(" ")).toContain("is draft");

    const [row] = await ctx.db
      .select()
      .from(automation_rules)
      .where(eq(automation_rules.id, created.id));
    const secretId = row?.actions[1]?.secret_id as string;
    expect(await ctx.vault.getSecret(secretId, ctx.workspace.id)).toBe(
      "a-very-long-signing-secret",
    );

    const updated = await call(automationsUpdate, {
      rule_id: created.id,
      enabled: false,
      actions: [{ type: "webhook", url: "https://hooks.example.org/in" }, { type: "notify" }],
    });
    expect(updated.enabled).toBe(false);
    expect(updated.actions[0].signed).toBe(true);
    const listed = await call(automationsList, { enabled: false });
    expect(listed.items.map((item: { id: string }) => item.id)).toContain(created.id);

    expect(await call(automationsDelete, { rule_id: created.id })).toEqual({
      rule_id: created.id,
      deleted: true,
    });
    expect(await ctx.vault.getSecret(secretId, ctx.workspace.id)).toBeNull();
  });

  it("rejects smart lists and unknown campaigns", async () => {
    const [smart] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: "Smart list", kind: "smart", filter: {} })
      .returning();
    const smartError = await failure(
      call(automationsCreate, {
        name: "Bad list",
        actions: [{ type: "add_to_list", list_id: smart?.id }],
      }),
    );
    expect(smartError.message).toContain("smart list");
    const missing = await failure(
      call(automationsCreate, {
        name: "Bad campaign",
        actions: [{ type: "enroll", campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" }],
      }),
    );
    expect(missing.code).toBe("not_found");
  });

  it("tests saved and draft rules against real signals without side effects", async () => {
    const company = await seedCompany(ctx, { fit_score: 80 });
    await seedPerson(ctx, { company_id: company.id });
    const funding = await signalFor(company.id, "funding_round");
    const news = await signalFor(company.id, "news_mention");
    const draft = await call(automationsTest, {
      filters: { definition_keys: ["funding_round"] },
      actions: [{ type: "notify" }, { type: "research", max_people: 1 }],
      limit: 50,
    });
    const byId = new Map(
      draft.results.map((item: { signal_id: string }) => [item.signal_id, item]),
    );
    expect(byId.get(funding.id)).toMatchObject({
      matched: true,
      people: 1,
      would: [
        "Send a notification to the workspace channels.",
        "Request research on 1 people and the company.",
      ],
    });
    expect(byId.get(news.id)).toMatchObject({ matched: false, would: [] });
    expect(ctx.recorded.approvals).toHaveLength(0);

    const saved = await call(automationsCreate, {
      name: "Funding notify",
      filters: { definition_keys: ["funding_round"], min_score: 99 },
      actions: [{ type: "notify" }],
    });
    const single = await call(automationsTest, { rule_id: saved.id, signal_id: funding.id });
    expect(single).toMatchObject({ checked: 1, matched: 0 });
    expect(single.results[0].reason).toContain("below min_score 99");
    expect((await failure(call(automationsTest, {}))).code).toBe("validation_failed");
  });
});

describe("webhook tokens", () => {
  it("shows the token once, lists prefixes and revokes", async () => {
    const created = await call(webhookTokensCreate, { name: "CRM workflow" });
    expect(created.token).toMatch(/^oosig_/);
    expect(created.url).toBe(`http://localhost:7331/hooks/signals/${created.token}`);
    expect(created.prefix).toBe(created.token.slice(0, 12));
    const listed = await call(webhookTokensList, {});
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed.items.map((item: { id: string }) => item.id)).toContain(created.id);
    const revoked = await call(webhookTokensRevoke, { token_id: created.id });
    expect(revoked.revoked_at).not.toBeNull();
    expect(await call(webhookTokensRevoke, { token_id: created.id })).toMatchObject({
      id: created.id,
    });
    const active = await call(webhookTokensList, {});
    expect(active.items.map((item: { id: string }) => item.id)).not.toContain(created.id);
    const all = await call(webhookTokensList, { include_revoked: true });
    expect(all.items.map((item: { id: string }) => item.id)).toContain(created.id);
  });
});

describe("definition changes reach intent", () => {
  it("disabling a definition drops its signals from the feed", async () => {
    const company = await seedCompany(ctx);
    const stored = await signalFor(company.id, "tech_adopted");
    await call(definitionsUpdate, { key: "tech_adopted", enabled: false });
    const feed = await call(signalsFeed, { company_id: company.id });
    expect(feed.items.map((item: { id: string }) => item.id)).not.toContain(stored.id);
    await ctx.db
      .update(signal_definitions)
      .set({ enabled: true })
      .where(
        and(
          eq(signal_definitions.workspace_id, ctx.workspace.id),
          eq(signal_definitions.key, "tech_adopted"),
        ),
      );
  });
});
