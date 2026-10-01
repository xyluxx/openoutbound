import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { crm_links, opportunities } from "../../db/schema/index.js";
import type { CrmProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedPerson } from "../../testing/factories.js";
import { crmStatus, linkCrmRecord, manageCrmTool } from "./crm-operations.js";
import { openCrmSyncProblem, writeLink } from "./crm-sync.js";
import { createCrmWebhook } from "./crm-webhook.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

type CrmSettings = NonNullable<WorkspaceSettingsInput["crm"]>;
const MISSING_PERSON = "pe_01k6a3v0q8x3m2n4p5r6s7t8v9";

function fullCrm() {
  return {
    id: "hubspot",
    upsertContact: vi.fn(async () => ({ contactId: "c-1" })),
    upsertDeal: vi.fn(async () => ({ dealId: "d-1" })),
    logActivity: vi.fn(async () => ({ activityId: "n-1" })),
    findContactByEmail: vi.fn(async () => null),
    deleteContact: vi.fn(async () => ({ deleted: true })),
  } satisfies CrmProvider;
}

async function setup(crm: CrmSettings = {}, crms: CrmProvider[] = [fullCrm()]) {
  const ctx = await createTestContext({ db: testDb, providers: { crm: crms }, settings: { crm } });
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, { company_id: company.id });
  const [opportunity] = await ctx.db
    .insert(opportunities)
    .values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      company_id: company.id,
      stage: "interested",
      crm_refs: { hubspot: "d-1" },
    })
    .returning();
  if (!opportunity) throw new Error("no opportunity");
  return { ctx, company, person, opportunity };
}

async function linkRows(ctx: TestContext, provider: string) {
  return ctx.db
    .select()
    .from(crm_links)
    .where(and(eq(crm_links.workspace_id, ctx.workspace.id), eq(crm_links.provider, provider)));
}

describe("crm.link", () => {
  it("stores the id an agent's CRM gave a record, and moves it when it changes", async () => {
    const { ctx, person } = await setup({ mode: "agent" }, []);
    const input = {
      provider: "Salesforce",
      entity_type: "person" as const,
      entity_id: person.id,
      external_id: "0035g00000XyZabAAB",
    };
    expect(await linkCrmRecord.handler(ctx, input)).toEqual({
      provider: "salesforce",
      entity_type: "person",
      entity_id: person.id,
      external_id: "0035g00000XyZabAAB",
      previous_external_id: null,
      changed: true,
    });
    expect(await linkCrmRecord.handler(ctx, input)).toMatchObject({ changed: false });
    expect(
      await linkCrmRecord.handler(ctx, { ...input, external_id: "0035g00000NewIdAAB" }),
    ).toMatchObject({ previous_external_id: "0035g00000XyZabAAB", changed: true });
    expect(await linkRows(ctx, "salesforce")).toEqual([
      expect.objectContaining({ entity_id: person.id, external_id: "0035g00000NewIdAAB" }),
    ]);
  });

  it("shows a linked deal with the opportunity, next to the built-in ids", async () => {
    const { ctx, opportunity } = await setup({ mode: "agent" });
    await linkCrmRecord.handler(ctx, {
      provider: "salesforce",
      entity_type: "opportunity",
      entity_id: opportunity.id,
      external_id: "0065g00000Deal1",
    });
    const [row] = await ctx.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id));
    expect(row?.crm_refs).toEqual({ hubspot: "d-1", salesforce: "0065g00000Deal1" });
    expect(ctx.recorded.events).toEqual([]);
  });

  it("checks the id belongs to the entity type and exists, and previews on a dry run", async () => {
    const { ctx, company } = await setup();
    await expect(
      linkCrmRecord.handler(ctx, {
        provider: "hubspot",
        entity_type: "person",
        entity_id: company.id,
        external_id: "1",
      }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "entity_id" } });
    await expect(
      linkCrmRecord.handler(ctx, {
        provider: "hubspot",
        entity_type: "person",
        entity_id: MISSING_PERSON,
        external_id: "1",
      }),
    ).rejects.toBeInstanceOf(OpenOutboundError);

    const preview = await linkCrmRecord.handler(ctx.with({ request: { dryRun: true } }), {
      provider: "hubspot",
      entity_type: "company",
      entity_id: company.id,
      external_id: "co-9",
    });
    expect(preview).toMatchObject({ dry_run: true, preview: { changed: true } });
    expect(await linkRows(ctx, "hubspot")).toEqual([]);
  });
});

describe("crm.status", () => {
  it("shows the mode, preferences, providers with their links, problems and the webhook", async () => {
    const { ctx, person, company, opportunity } = await setup();
    await writeLink(ctx, "hubspot", "person", person.id, "c-1");
    await writeLink(ctx, "hubspot", "company", company.id, "co-1");
    await writeLink(ctx, "hubspot", "opportunity", opportunity.id, "d-1");
    await writeLink(ctx, "hubspot", "activity", "evt_1", "n-1");
    ctx.clock.advanceBy({ hours: 2 });
    await writeLink(ctx, "salesforce", "person", person.id, "0035g00000XyZab");

    const status = await crmStatus.handler(ctx, {});
    expect(status).toMatchObject({
      mode: "built_in",
      preferences: {
        sync_from: "interested",
        log: "deals",
        timing: "live",
        stage_owner: "engine",
        on_forget: "task",
        skip_owned_accounts: false,
        allow_outreach_with_open_deal: false,
        notes: "",
      },
      daily: null,
      problems: { items: [], more: false },
      webhook: { exists: false, token_hint: null, created_at: null, last_used_at: null },
    });
    expect(status.providers).toEqual([
      {
        provider: "hubspot",
        configured: true,
        can: { notes: true, find: true, delete: true },
        people: 1,
        companies: 1,
        deals: 1,
        notes_logged: 1,
        last_synced_at: new Date("2026-09-19T12:00:00Z"),
      },
      {
        provider: "salesforce",
        configured: false,
        can: null,
        people: 1,
        companies: 0,
        deals: 0,
        notes_logged: 0,
        last_synced_at: new Date("2026-09-19T14:00:00Z"),
      },
    ]);
    expect(status.next_steps).toEqual([
      "To let your CRM report customers, open deals and owners by itself, create the inbound URL with manage_crm action webhook.",
    ]);

    await openCrmSyncProblem(ctx, "hubspot", new Error("HubSpot is down"));
    await createCrmWebhook.handler(ctx, { rotate: false });
    const later = await crmStatus.handler(ctx, {});
    expect(later.problems.items).toEqual([
      expect.objectContaining({
        kind: "crm_sync_failed",
        severity: "high",
        title: "CRM sync to HubSpot is failing",
      }),
    ]);
    expect(later.webhook).toMatchObject({ exists: true, token_hint: expect.any(String) });
    expect(later.next_steps).toEqual([
      "Fix the open CRM problems below; each names its remedy. They resolve on the next successful sync or by hand.",
    ]);
  });

  it("says what to do next for each way of running the CRM", async () => {
    const none = await setup({}, []);
    expect((await crmStatus.handler(none.ctx, {})).next_steps[0]).toContain(
      "No CRM provider is configured",
    );

    const agent = await setup({ mode: "agent" }, []);
    const agentStatus = await crmStatus.handler(agent.ctx, {});
    expect(agentStatus.mode).toBe("agent");
    expect(agentStatus.next_steps[0]).toContain('event_feed action list with consumer "crm"');

    const everything = await setup({ log: "everything", timing: "daily" });
    const everythingStatus = await crmStatus.handler(everything.ctx, {});
    expect(everythingStatus.daily).toEqual({ consumer: "crm.builtin", position_at: null });
    expect(everythingStatus.next_steps).toContain(
      "crm.log is everything: the text of every email sent and received is copied into the CRM (cut to 2000 characters).",
    );

    const off = await setup({ mode: "off", log: "everything" });
    expect((await crmStatus.handler(off.ctx, {})).next_steps).toEqual([
      'Nothing reaches a CRM. To change that (built_in, or "agent" to sync with your own CRM tools): ask the human to change settings.crm.mode (openoutbound workspaces update); to suggest it, use manage_strategy action propose (operation workspaces.update, input {"settings":{"crm":{"mode":"built_in"}}}).',
    ]);
  });
});

describe("manage_crm", () => {
  it("is a core tool over the CRM operations", () => {
    expect(manageCrmTool).toMatchObject({
      name: "manage_crm",
      toolset: "core",
      actions: {
        status: "crm.status",
        record_facts: "crm.facts",
        link: "crm.link",
        webhook: "crm.create_webhook",
        sync: "crm.sync",
      },
    });
  });
});
