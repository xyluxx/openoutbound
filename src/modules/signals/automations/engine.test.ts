import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AutomationAction,
  automation_firings,
  automation_rules,
  companies,
  list_members,
  lists,
  people,
  signals,
} from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedCampaign, seedCompany, seedPerson } from "../../../testing/factories.js";
import { storeSignal } from "../service.js";
import { signWebhookBody } from "./actions.js";
import { runAutomationsForSignal, runAutomationsHandler } from "./engine.js";

const mocks = vi.hoisted(() => ({
  notify: vi.fn(async () => {}),
  requestResearch: vi.fn(async () => ({ jobIds: ["job_1"], cachedBriefIds: [] as string[] })),
}));
vi.mock("../../../runtime/notify.js", () => ({ notify: mocks.notify }));
vi.mock("../../research/service.js", () => ({ requestResearch: mocks.requestResearch }));

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  ctx.recorded.events.length = 0;
  ctx.recorded.approvals.length = 0;
  mocks.notify.mockClear();
  mocks.requestResearch.mockClear();
  await ctx.db.delete(automation_rules).where(eq(automation_rules.workspace_id, ctx.workspace.id));
});

async function rule(
  filters: Record<string, unknown>,
  actions: AutomationAction[],
  extra: { require_approval?: boolean; enabled?: boolean; name?: string } = {},
) {
  const [row] = await ctx.db
    .insert(automation_rules)
    .values({
      workspace_id: ctx.workspace.id,
      name: extra.name ?? "Test rule",
      trigger: { event: "signal.detected", filters },
      actions,
      require_approval: extra.require_approval ?? false,
      enabled: extra.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error("rule insert failed");
  return row;
}

let counter = 0;
async function signalAt(
  companyId: string,
  overrides: { key?: string; personId?: string; strength?: number } = {},
) {
  counter += 1;
  const result = await storeSignal(ctx, {
    definition_key: overrides.key ?? "funding_round",
    title: `Raised a round ${counter}`,
    evidence_url: `https://news.example.org/round-${counter}`,
    source: "test",
    strength: overrides.strength ?? 1,
    companyId,
    ...(overrides.personId ? { personId: overrides.personId } : {}),
  });
  return result.id;
}

async function scenario(fit = 80) {
  const company = await seedCompany(ctx, { fit_score: fit });
  const alice = await seedPerson(ctx, { company_id: company.id, fit_score: 90 });
  const bob = await seedPerson(ctx, { company_id: company.id, fit_score: 40, email: null });
  const blocked = await seedPerson(ctx, { company_id: company.id, status: "do_not_contact" });
  return { company, alice, bob, blocked };
}

describe("automation filters", () => {
  it("fires matching rules once per signal and records what happened", async () => {
    const { company, alice, bob } = await scenario();
    const [list] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: `Hot accounts ${counter}` })
      .returning();
    const fired = await rule({ definition_keys: ["funding_round"], min_score: 20 }, [
      { type: "notify" },
      { type: "add_to_list", list_id: list?.id ?? "", max_people: 5 },
    ]);
    const other = await rule({ definition_keys: ["tech_adopted"] }, [{ type: "notify" }]);
    const signalId = await signalAt(company.id);

    const first = await runAutomationsForSignal(ctx, signalId);
    expect(first.outcomes.find((item) => item.rule_id === other.id)).toMatchObject({
      status: "not_matched",
    });
    const outcome = first.outcomes.find((item) => item.rule_id === fired.id);
    expect(outcome?.status).toBe("fired");
    expect(outcome?.results).toEqual([
      { type: "notify", status: "ok" },
      { type: "add_to_list", status: "ok", count: 2 },
    ]);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const members = await ctx.db
      .select({ person_id: list_members.person_id })
      .from(list_members)
      .where(eq(list_members.list_id, list?.id ?? ""));
    // Best fit first; the do_not_contact person is never added.
    expect(members.map((member) => member.person_id).sort()).toEqual([alice.id, bob.id].sort());

    const again = await runAutomationsForSignal(ctx, signalId);
    expect(again.outcomes.find((item) => item.rule_id === fired.id)?.status).toBe("already_fired");
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const firings = await ctx.db
      .select()
      .from(automation_firings)
      .where(eq(automation_firings.signal_id, signalId));
    expect(firings).toHaveLength(1);
    const [stored] = await ctx.db
      .select()
      .from(automation_rules)
      .where(eq(automation_rules.id, fired.id));
    expect(stored?.last_fired_at).toBeInstanceOf(Date);
  });

  it("applies min_score, min_fit, has_email and list filters", async () => {
    const { company, alice } = await scenario(30);
    const lowFit = await rule({ min_fit: 50 }, [{ type: "notify" }]);
    const highScore = await rule({ min_score: 90 }, [{ type: "notify" }]);
    const withEmail = await rule({ has_email: true }, [
      { type: "tag", tag: "Has-Email", target: "people" },
    ]);
    const [list] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: `Empty list ${counter}` })
      .returning();
    const inList = await rule({ list_id: list?.id }, [{ type: "notify" }]);
    const signalId = await signalAt(company.id, { strength: 0.8 });
    const result = await runAutomationsForSignal(ctx, signalId);
    const byRule = new Map(result.outcomes.map((item) => [item.rule_id, item]));
    expect(byRule.get(lowFit.id)?.reason).toContain("below min_fit 50");
    expect(byRule.get(highScore.id)?.reason).toContain("below min_score 90");
    expect(byRule.get(inList.id)?.reason).toContain(`no person in list ${list?.id}`);
    expect(byRule.get(withEmail.id)?.status).toBe("fired");
    const [tagged] = await ctx.db.select().from(people).where(eq(people.id, alice.id));
    expect(tagged?.tags).toContain("has-email");
  });

  it("ignores dismissed signals and disabled rules", async () => {
    const { company } = await scenario();
    await rule({}, [{ type: "notify" }], { enabled: false });
    const signalId = await signalAt(company.id);
    expect((await runAutomationsForSignal(ctx, signalId)).rules_checked).toBe(0);
    await rule({}, [{ type: "notify" }]);
    await ctx.db.update(signals).set({ status: "dismissed" }).where(eq(signals.id, signalId));
    expect((await runAutomationsForSignal(ctx, signalId)).rules_checked).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

describe("automation actions", () => {
  it("asks for an enrollment approval when require_approval is on", async () => {
    const { company, alice } = await scenario();
    const { campaign } = await seedCampaign(ctx, { status: "active" });
    const enroll = await rule({}, [{ type: "enroll", campaign_id: campaign.id, max_people: 1 }], {
      require_approval: true,
      name: "Funding follow-up",
    });
    const signalId = await signalAt(company.id);
    const result = await runAutomationsForSignal(ctx, signalId, { enrollEventAvailable: true });
    const outcome = result.outcomes.find((item) => item.rule_id === enroll.id);
    expect(outcome?.results?.[0]).toMatchObject({
      type: "enroll",
      status: "approval_requested",
      count: 1,
    });
    expect(ctx.recorded.approvals).toHaveLength(1);
    expect(ctx.recorded.approvals[0]?.request).toMatchObject({
      kind: "enrollment",
      payload: {
        campaign_id: campaign.id,
        person_ids: [alice.id],
        source: `automation:${enroll.id}`,
        signal_id: signalId,
      },
    });
    expect(ctx.emitted("signal.detected").length).toBeGreaterThan(0);
  });

  it("emits automation.enroll_requested when campaigns can take it, else falls back to approval", async () => {
    const { company, alice } = await scenario();
    const { campaign } = await seedCampaign(ctx, { status: "active" });
    await rule({}, [{ type: "enroll", campaign_id: campaign.id, max_people: 1 }]);
    const first = await signalAt(company.id);
    await runAutomationsForSignal(ctx, first, { enrollEventAvailable: true });
    const requested = ctx.recorded.events.filter(
      (event) => event.type === ("automation.enroll_requested" as string),
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]?.data).toMatchObject({
      campaign_id: campaign.id,
      person_ids: [alice.id],
      signal_id: first,
    });
    expect(ctx.recorded.approvals).toHaveLength(0);

    const second = await signalAt(company.id);
    const result = await runAutomationsForSignal(ctx, second, { enrollEventAvailable: false });
    expect(result.outcomes[0]?.results?.[0]?.status).toBe("approval_requested");
    expect(ctx.recorded.approvals).toHaveLength(1);
  });

  it("fails the enroll action for an archived campaign without throwing", async () => {
    const { company } = await scenario();
    const { campaign } = await seedCampaign(ctx, { status: "archived" });
    await rule({}, [{ type: "enroll", campaign_id: campaign.id }, { type: "notify" }]);
    const result = await runAutomationsForSignal(ctx, await signalAt(company.id));
    expect(result.outcomes[0]?.status).toBe("fired");
    expect(result.outcomes[0]?.results?.map((item) => item.status)).toEqual(["failed", "ok"]);
  });

  it("requests research for the people and the company", async () => {
    const { company, alice } = await scenario();
    await rule({}, [{ type: "research", max_people: 1 }]);
    await runAutomationsForSignal(ctx, await signalAt(company.id));
    expect(mocks.requestResearch).toHaveBeenCalledWith(expect.anything(), {
      personIds: [alice.id],
      companyIds: [company.id],
    });
  });

  it("posts a signed webhook", async () => {
    const { company } = await scenario();
    const secretId = await ctx.vault.putSecret(
      ctx.workspace.id,
      "automation-test-secret",
      "a-long-signing-secret-value",
    );
    ctx.fetch.route("https://hooks.example.org/signals", { body: "ok" }, "POST");
    await rule({}, [
      { type: "webhook", url: "https://hooks.example.org/signals", secret_id: secretId },
    ]);
    const result = await runAutomationsForSignal(ctx, await signalAt(company.id));
    expect(result.outcomes[0]?.results?.[0]).toMatchObject({ type: "webhook", status: "ok" });
    const call = ctx.recorded.fetch.find(
      (item) => item.url === "https://hooks.example.org/signals",
    );
    const headers = call?.init?.headers as Record<string, string>;
    const body = String(call?.init?.body);
    const t = Math.floor(ctx.clock.now().getTime() / 1000);
    expect(headers["openoutbound-signature"]).toBe(
      signWebhookBody("a-long-signing-secret-value", body, t),
    );
    const expected = createHmac("sha256", "a-long-signing-secret-value")
      .update(`${t}.${body}`)
      .digest("hex");
    expect(headers["openoutbound-signature"]).toBe(`t=${t},v1=${expected}`);
    expect(JSON.parse(body)).toMatchObject({
      type: "automation.fired",
      company: { id: company.id },
      signal: { definition_key: "funding_round" },
    });
  });

  it("records a failed webhook without stopping other actions", async () => {
    const { company } = await scenario();
    ctx.fetch.route("https://hooks.example.org/down", { status: 503 }, "POST");
    await rule({}, [
      { type: "webhook", url: "https://hooks.example.org/down" },
      { type: "tag", tag: "hot" },
    ]);
    const result = await runAutomationsForSignal(ctx, await signalAt(company.id));
    expect(result.outcomes[0]?.results).toMatchObject([
      { type: "webhook", status: "failed", detail: "Receiver answered HTTP 503." },
      { type: "tag", status: "ok", count: 1 },
    ]);
    const [row] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(row?.tags).toEqual(["hot"]);
  });
});

describe("automation safety caps", () => {
  it("stops a rule at max_fires_per_day", async () => {
    const { company } = await scenario();
    const capped = await rule({ max_fires_per_day: 1 }, [{ type: "notify" }]);
    await runAutomationsForSignal(ctx, await signalAt(company.id));
    const second = await runAutomationsForSignal(ctx, await signalAt(company.id));
    expect(second.outcomes[0]).toMatchObject({ rule_id: capped.id, status: "skipped" });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("caps the actions one signal can run across rules", async () => {
    const { company } = await scenario();
    for (let index = 0; index < 5; index += 1) {
      await rule(
        {},
        Array.from({ length: 5 }, () => ({ type: "notify" as const })),
      );
    }
    const result = await runAutomationsForSignal(ctx, await signalAt(company.id));
    expect(result.outcomes.map((item) => item.status)).toEqual([
      "fired",
      "fired",
      "fired",
      "fired",
      "skipped",
    ]);
    expect(mocks.notify).toHaveBeenCalledTimes(20);
  });

  it("runs from the signal.detected event handler", async () => {
    const { company } = await scenario();
    await rule({}, [{ type: "notify" }]);
    const signalId = await signalAt(company.id);
    const [event] = ctx
      .emitted("signal.detected")
      .filter((item) => item.data.signal_id === signalId);
    expect(event).toBeDefined();
    if (!event) return;
    await runAutomationsHandler.handler(ctx.jobContext(), {
      id: event.id,
      type: "signal.detected",
      workspaceId: ctx.workspace.id,
      subject: event.subject,
      data: event.data,
      occurredAt: ctx.clock.now(),
    });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const [firing] = await ctx.db
      .select()
      .from(automation_firings)
      .where(and(eq(automation_firings.signal_id, signalId)));
    expect(firing?.status).toBe("fired");
  });
});
