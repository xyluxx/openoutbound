import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import type { EmittedEvent } from "../../core/events.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { crm_links, type Opportunity, opportunities, problems } from "../../db/schema/index.js";
import type { CrmProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedPerson } from "../../testing/factories.js";
import { type CrmEvent, processCrmEvent, syncCrmOnOpportunityUpdate } from "./crm-events.js";
import { CRM_SYNC_JOB, crmSyncJob, syncCrm, syncOpportunityToCrm } from "./crm-sync.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

function fakeCrm(id = "hubspot") {
  let n = 0;
  const crm = {
    id,
    upsertContact: vi.fn(async (_person, company, existing) => {
      n += 1;
      const contactId = existing?.contactId ?? `contact-${n}`;
      return company
        ? { contactId, companyId: existing?.companyId ?? `company-${n}` }
        : { contactId };
    }),
    upsertDeal: vi.fn(async (_opportunity, links, _options) => {
      n += 1;
      return { dealId: links.dealId ?? `deal-${n}` };
    }),
  } satisfies CrmProvider;
  return crm;
}

async function setup(crms: CrmProvider[] = [fakeCrm()], settings: WorkspaceSettingsInput = {}) {
  const ctx = await createTestContext({ db: testDb, providers: { crm: crms }, settings });
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, { company_id: company.id, full_name: "Dana Reyes" });
  const [opportunity] = await ctx.db
    .insert(opportunities)
    .values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      company_id: company.id,
      stage: "interested",
      value: 12000,
      currency: "EUR",
    })
    .returning();
  if (!opportunity) throw new Error("no opportunity");
  return { ctx, company, person, opportunity };
}

async function linksOf(ctx: TestContext) {
  const rows = await ctx.db
    .select()
    .from(crm_links)
    .where(eq(crm_links.workspace_id, ctx.workspace.id));
  return Object.fromEntries(
    rows.map((row) => [`${row.provider}:${row.entity_type}`, row.external_id]),
  );
}

async function reload(ctx: TestContext, id: string): Promise<Opportunity> {
  const [row] = await ctx.db.select().from(opportunities).where(eq(opportunities.id, id));
  if (!row) throw new Error("missing");
  return row;
}

async function crmProblems(ctx: TestContext) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "crm_sync_failed")));
}

describe("syncOpportunityToCrm", () => {
  it("pushes contact, company and deal, stores the links and updates in place next time", async () => {
    const crm = fakeCrm();
    const { ctx, person, company, opportunity } = await setup([crm]);

    const first = await syncOpportunityToCrm(ctx, opportunity.id);
    expect(first).toMatchObject({
      skipped: null,
      rounds: 1,
      providers: [
        {
          provider: "hubspot",
          ok: true,
          contact_id: "contact-1",
          company_id: "company-1",
          deal_id: "deal-2",
          reused_deal: false,
        },
      ],
    });
    expect(crm.upsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ id: person.id }),
      expect.objectContaining({ id: company.id }),
      { contactId: undefined, companyId: undefined },
    );
    expect(crm.upsertDeal).toHaveBeenCalledWith(
      expect.objectContaining({ id: opportunity.id }),
      { contactId: "contact-1", companyId: "company-1", dealId: undefined },
      { title: `Harbor Dental (OpenOutbound ${opportunity.id.slice(-8)})`, keepStage: false },
    );
    expect(await linksOf(ctx)).toEqual({
      "hubspot:person": "contact-1",
      "hubspot:company": "company-1",
      "hubspot:opportunity": "deal-2",
    });
    expect((await reload(ctx, opportunity.id)).crm_refs).toEqual({ hubspot: "deal-2" });

    // Second sync: the stored ids are passed back, so nothing is created twice.
    await ctx.db
      .update(opportunities)
      .set({ stage: "won" })
      .where(eq(opportunities.id, opportunity.id));
    const second = await syncOpportunityToCrm(ctx, opportunity.id);
    expect(second.providers[0]).toMatchObject({ ok: true, deal_id: "deal-2" });
    expect(crm.upsertContact).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
      contactId: "contact-1",
      companyId: "company-1",
    });
    expect(crm.upsertDeal).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: "won" }),
      { contactId: "contact-1", companyId: "company-1", dealId: "deal-2" },
      expect.objectContaining({ keepStage: false }),
    );
    const rows = await ctx.db
      .select()
      .from(crm_links)
      .where(eq(crm_links.workspace_id, ctx.workspace.id));
    expect(rows).toHaveLength(3);
  });

  it("keeps separate links per provider", async () => {
    const hubspot = fakeCrm("hubspot");
    const pipedrive = fakeCrm("pipedrive");
    const { ctx, opportunity } = await setup([hubspot, pipedrive]);
    const result = await syncOpportunityToCrm(ctx, opportunity.id);
    expect(result.providers.map((entry) => entry.provider)).toEqual(["hubspot", "pipedrive"]);
    expect(Object.keys(await linksOf(ctx)).sort()).toEqual([
      "hubspot:company",
      "hubspot:opportunity",
      "hubspot:person",
      "pipedrive:company",
      "pipedrive:opportunity",
      "pipedrive:person",
    ]);
    expect(Object.keys((await reload(ctx, opportunity.id)).crm_refs).sort()).toEqual([
      "hubspot",
      "pipedrive",
    ]);
  });

  it("syncs company-only opportunities without a contact", async () => {
    const crm = fakeCrm();
    const { ctx, company } = await setup([crm]);
    const [row] = await ctx.db
      .insert(opportunities)
      .values({ workspace_id: ctx.workspace.id, company_id: company.id, stage: "interested" })
      .returning();
    const result = await syncOpportunityToCrm(ctx, row?.id ?? "");
    expect(crm.upsertContact).not.toHaveBeenCalled();
    expect(result.providers[0]).toMatchObject({ ok: true, contact_id: null });
  });

  it("runs another round when the opportunity changed during the sync", async () => {
    const crm = fakeCrm();
    const { ctx, opportunity } = await setup([crm]);
    // Someone else moves the opportunity while the deal is written (their write lands once the
    // sync releases the deal's lock).
    let change: Promise<unknown> = Promise.resolve();
    crm.upsertDeal.mockImplementationOnce(async () => {
      change = ctx.db
        .update(opportunities)
        .set({ stage: "meeting_booked" })
        .where(eq(opportunities.id, opportunity.id))
        .execute();
      return { dealId: "deal-x" };
    });
    const result = await syncOpportunityToCrm(ctx, opportunity.id);
    await change;
    expect(result.rounds).toBe(2);
    expect(crm.upsertDeal).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: "meeting_booked" }),
      expect.objectContaining({ dealId: "deal-x" }),
      expect.anything(),
    );
  });

  it("reports permanent failures and throws on temporary ones so the job retries", async () => {
    const broken = fakeCrm("pipedrive");
    const { ctx, opportunity } = await setup([fakeCrm("hubspot"), broken]);
    broken.upsertContact.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "Pipedrive rejected the credentials.", {
        details: { reason: "unauthorized" },
      }),
    );
    const result = await syncOpportunityToCrm(ctx, opportunity.id);
    expect(result.providers).toEqual([
      expect.objectContaining({ provider: "hubspot", ok: true }),
      expect.objectContaining({
        provider: "pipedrive",
        ok: false,
        error: "Pipedrive rejected the credentials.",
      }),
    ]);

    broken.upsertDeal.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "Pipedrive rate limit reached.", {
        retryAfterSeconds: 7,
      }),
    );
    await expect(
      crmSyncJob.handler(ctx.jobContext(), { opportunity_id: opportunity.id }),
    ).rejects.toMatchObject({ retryAfterSeconds: 7 });
  });

  it("skips when no CRM is configured or the opportunity is gone", async () => {
    const { ctx, opportunity } = await setup([]);
    expect(await syncOpportunityToCrm(ctx, opportunity.id)).toMatchObject({
      skipped: "no_crm_provider",
    });
    const withCrm = await setup();
    expect(await syncOpportunityToCrm(withCrm.ctx, "opp_01k6a3v0q8x3m2n4p5r6s7t8v9")).toMatchObject(
      {
        skipped: "not_found",
      },
    );
  });

  it("never pushes in agent or off mode", async () => {
    for (const mode of ["agent", "off"] as const) {
      const crm = fakeCrm();
      const { ctx, opportunity } = await setup([crm], { crm: { mode } });
      expect(await syncOpportunityToCrm(ctx, opportunity.id)).toMatchObject({
        skipped: `mode_${mode}`,
        providers: [],
      });
      expect(crm.upsertContact).not.toHaveBeenCalled();
      expect(crm.upsertDeal).not.toHaveBeenCalled();
    }
  });

  it("leaves the stage of existing deals to the CRM with stage_owner crm", async () => {
    const crm = fakeCrm();
    const { ctx, opportunity } = await setup([crm], { crm: { stage_owner: "crm" } });
    await syncOpportunityToCrm(ctx, opportunity.id);
    expect(crm.upsertDeal).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ keepStage: true }),
    );
  });

  it("looks for the deal before creating one, so a retry after a lost answer reuses it", async () => {
    const crm = {
      ...fakeCrm(),
      findContactByEmail: vi.fn(async () => "contact-found"),
      findDealForContact: vi.fn(async () => "deal-from-crm"),
    } satisfies CrmProvider;
    const { ctx, person, opportunity } = await setup([crm]);
    const result = await syncOpportunityToCrm(ctx, opportunity.id);
    expect(crm.findContactByEmail).toHaveBeenCalledWith(person.email);
    expect(crm.upsertContact).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      contactId: "contact-found",
      companyId: undefined,
    });
    expect(crm.findDealForContact).toHaveBeenCalledWith(
      "contact-found",
      `Harbor Dental (OpenOutbound ${opportunity.id.slice(-8)})`,
    );
    expect(crm.upsertDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dealId: "deal-from-crm" }),
      expect.anything(),
    );
    expect(result.providers[0]).toMatchObject({ deal_id: "deal-from-crm", reused_deal: true });

    // Once linked, the CRM is not searched again.
    await syncOpportunityToCrm(ctx, opportunity.id);
    expect(crm.findDealForContact).toHaveBeenCalledTimes(1);
    expect(crm.findContactByEmail).toHaveBeenCalledTimes(1);
  });

  it("never merges a new opportunity into the deal of an earlier one", async () => {
    // A CRM whose deal search answers by title, like HubSpot and Pipedrive.
    const titles = new Map<string, string>();
    const crm = fakeCrm();
    crm.upsertDeal.mockImplementation(async (_opportunity, links, options) => {
      const dealId = links.dealId ?? `deal-${titles.size + 1}`;
      if (options?.title) titles.set(options.title, dealId);
      return { dealId };
    });
    const searching = {
      ...crm,
      findDealForContact: vi.fn(
        async (_contactId: string, title: string) => titles.get(title) ?? null,
      ),
    } satisfies CrmProvider;
    const { ctx, person, company, opportunity: march } = await setup([searching]);
    await syncOpportunityToCrm(ctx, march.id);
    await ctx.db
      .update(opportunities)
      .set({ stage: "won", closed_at: ctx.clock.now() })
      .where(eq(opportunities.id, march.id));
    await syncOpportunityToCrm(ctx, march.id);

    // July: a new opportunity for the same person gets its own deal; March's stays won.
    const [july] = await ctx.db
      .insert(opportunities)
      .values({
        workspace_id: ctx.workspace.id,
        person_id: person.id,
        company_id: company.id,
        stage: "interested",
      })
      .returning();
    const result = await syncOpportunityToCrm(ctx, july?.id ?? "");
    expect(result.providers[0]).toMatchObject({ ok: true, deal_id: "deal-2", reused_deal: false });
    expect(crm.upsertDeal).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: july?.id, stage: "interested" }),
      expect.objectContaining({ dealId: undefined }),
      expect.objectContaining({ title: `Harbor Dental (OpenOutbound ${july?.id.slice(-8)})` }),
    );
    expect((await reload(ctx, march.id)).crm_refs).toEqual({ hubspot: "deal-1" });

    // A search that finds a deal another opportunity already has is never trusted.
    searching.findDealForContact.mockResolvedValueOnce("deal-1");
    const [august] = await ctx.db
      .insert(opportunities)
      .values({ workspace_id: ctx.workspace.id, person_id: person.id, stage: "interested" })
      .returning();
    const again = await syncOpportunityToCrm(ctx, august?.id ?? "");
    expect(again.providers[0]).toMatchObject({ reused_deal: false });
    expect(again.providers[0]?.deal_id).not.toBe("deal-1");
  });

  it("creates one contact and one deal when syncs and note jobs race for a new person", async () => {
    let contacts = 0;
    let deals = 0;
    const slow = () => new Promise((resolve) => setTimeout(resolve, 15));
    const crm = {
      id: "hubspot",
      // The CRM's search does not see a contact created a moment ago (as with real search indexes).
      findContactByEmail: vi.fn(async () => null),
      upsertContact: vi.fn(async (_person, _company, existing) => {
        await slow();
        if (existing?.contactId) return { contactId: existing.contactId };
        contacts += 1;
        return { contactId: `contact-${contacts}` };
      }),
      upsertDeal: vi.fn(async (_opportunity, links) => {
        await slow();
        if (links.dealId) return { dealId: links.dealId };
        deals += 1;
        return { dealId: `deal-${deals}` };
      }),
      logNote: vi.fn(async () => {}),
    } satisfies CrmProvider;
    const { ctx, person, opportunity } = await setup([crm], { crm: { log: "key_moments" } });
    const meeting = (id: string) =>
      processCrmEvent(ctx, {
        id,
        type: "meeting.booked",
        data: {
          meeting_id: `mtg_${id}`,
          person_id: person.id,
          opportunity_id: opportunity.id,
          start_at: "2026-10-08T13:00:00.000Z",
          source: "calendly",
        },
        occurredAt: ctx.clock.now(),
      } as CrmEvent);
    await Promise.all([
      syncOpportunityToCrm(ctx, opportunity.id),
      meeting("evt_a"),
      syncOpportunityToCrm(ctx, opportunity.id),
      meeting("evt_b"),
    ]);
    expect(contacts).toBe(1);
    expect(deals).toBe(1);
    const links = await ctx.db
      .select()
      .from(crm_links)
      .where(eq(crm_links.workspace_id, ctx.workspace.id));
    expect(links.filter((row) => row.entity_type === "person")).toEqual([
      expect.objectContaining({ external_id: "contact-1" }),
    ]);
    expect(links.filter((row) => row.entity_type === "opportunity")).toEqual([
      expect.objectContaining({ external_id: "deal-1" }),
    ]);
  });

  it("opens one crm_sync_failed problem when the engine gives up, and resolves it after a success", async () => {
    const crm = fakeCrm("pipedrive");
    const { ctx, opportunity } = await setup([crm]);
    const bad = new OpenOutboundError("provider_error", "Pipedrive rejected the credentials.", {
      details: { reason: "unauthorized", status: 401 },
    });
    crm.upsertContact.mockRejectedValueOnce(bad).mockRejectedValueOnce(bad);
    await syncOpportunityToCrm(ctx, opportunity.id);
    await syncOpportunityToCrm(ctx, opportunity.id);
    let open = await crmProblems(ctx);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      severity: "high",
      owner: "person",
      status: "open",
      dedupe_key: "crm_sync_failed:pipedrive",
      title: "CRM sync to Pipedrive is failing",
      data: expect.objectContaining({
        provider: "pipedrive",
        reason: "auth_invalid",
        failure: expect.objectContaining({ class: "auth_invalid", retryable: false }),
        status: 401,
      }),
    });
    expect(open[0]?.remedy).toContain("manage_providers action test");
    expect(open[0]?.remedy).toContain("crm.mode");
    expect(ctx.emitted("problem.opened")).toHaveLength(1);

    await syncOpportunityToCrm(ctx, opportunity.id);
    open = await crmProblems(ctx);
    expect(open[0]).toMatchObject({ status: "resolved" });
    expect(ctx.emitted("problem.resolved")).toHaveLength(1);
  });

  it("opens the problem for temporary failures only on the last attempt", async () => {
    const crm = fakeCrm();
    const { ctx, opportunity } = await setup([crm]);
    const busy = new OpenOutboundError("provider_error", "HubSpot had a server error (503).", {
      details: { reason: "server_error", retryable: true },
    });
    crm.upsertDeal.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);
    await expect(
      crmSyncJob.handler(ctx.jobContext({ attempt: 1, maxAttempts: 6 }), {
        opportunity_id: opportunity.id,
      }),
    ).rejects.toBe(busy);
    expect(await crmProblems(ctx)).toHaveLength(0);
    await expect(
      crmSyncJob.handler(ctx.jobContext({ attempt: 6, maxAttempts: 6 }), {
        opportunity_id: opportunity.id,
      }),
    ).rejects.toBe(busy);
    expect(await crmProblems(ctx)).toHaveLength(1);
  });
});

describe("opportunity.updated handler", () => {
  function eventFor(ctx: TestContext, opportunity: Opportunity) {
    const event: EmittedEvent<"opportunity.updated"> = {
      id: "evt_1",
      type: "opportunity.updated",
      workspaceId: ctx.workspace.id,
      subject: { type: "opportunity", id: opportunity.id },
      data: {
        opportunity_id: opportunity.id,
        stage: "interested",
        previous_stage: null,
        person_id: opportunity.person_id,
        company_id: opportunity.company_id,
      },
      occurredAt: ctx.clock.now(),
    };
    return event;
  }

  it("queues one sync job per opportunity when a CRM is configured", async () => {
    const { ctx, opportunity } = await setup();
    const job = ctx.jobContext();
    const event = eventFor(ctx, opportunity);
    await syncCrmOnOpportunityUpdate.handler(job, event);
    await syncCrmOnOpportunityUpdate.handler(job, event);
    expect(ctx.enqueued(CRM_SYNC_JOB)).toHaveLength(1);
    expect(ctx.enqueued(CRM_SYNC_JOB)[0]?.options.singletonKey).toBe(
      `${CRM_SYNC_JOB}:${opportunity.id}`,
    );

    const none = await setup([]);
    await syncCrmOnOpportunityUpdate.handler(none.ctx.jobContext(), event);
    expect(none.ctx.enqueued(CRM_SYNC_JOB)).toHaveLength(0);
  });

  it("does nothing in agent or off mode, or with daily timing", async () => {
    for (const crm of [{ mode: "agent" }, { mode: "off" }, { timing: "daily" }] as const) {
      const { ctx, opportunity } = await setup([fakeCrm()], { crm });
      await syncCrmOnOpportunityUpdate.handler(ctx.jobContext(), eventFor(ctx, opportunity));
      expect(ctx.enqueued(CRM_SYNC_JOB)).toHaveLength(0);
    }
  });
});

describe("crm.sync", () => {
  it("previews on a dry run, queues open opportunities and needs a provider", async () => {
    const { ctx, opportunity } = await setup();
    const preview = await syncCrm.handler(ctx.with({ request: { dryRun: true } }), { limit: 100 });
    expect(preview).toMatchObject({
      dry_run: true,
      preview: { providers: ["hubspot"], opportunities: 1, sample: [{ id: opportunity.id }] },
      warnings: [],
    });
    expect(ctx.enqueued(CRM_SYNC_JOB)).toHaveLength(0);

    const queued = await syncCrm.handler(ctx, { limit: 100 });
    expect(queued).toMatchObject({ providers: ["hubspot"], queued: 1 });
    expect(ctx.enqueued(CRM_SYNC_JOB)[0]?.payload).toEqual({ opportunity_id: opportunity.id });

    const none = await setup([]);
    await expect(syncCrm.handler(none.ctx, { limit: 100 })).rejects.toMatchObject({
      code: "provider_not_configured",
    });
    await expect(
      syncCrm.handler(ctx, { opportunity_id: "opp_01k6a3v0q8x3m2n4p5r6s7t8v9", limit: 100 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses in agent and off mode with an error naming the mode and the setting", async () => {
    for (const mode of ["agent", "off"] as const) {
      const { ctx } = await setup([fakeCrm()], { crm: { mode } });
      const error = await syncCrm.handler(ctx, { limit: 100 }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "conflict",
        details: { setting: "crm.mode", value: mode },
      });
      expect((error as OpenOutboundError).message).toContain(`crm.mode is ${mode}`);
      expect((error as OpenOutboundError).hint).toContain("manage_strategy action propose");
      expect(ctx.enqueued(CRM_SYNC_JOB)).toHaveLength(0);

      const preview = await syncCrm.handler(ctx.with({ request: { dryRun: true } }), {
        limit: 100,
      });
      expect(preview).toMatchObject({ dry_run: true });
      expect(JSON.stringify(preview)).toContain(`crm.mode is ${mode}`);
    }
  });
});
