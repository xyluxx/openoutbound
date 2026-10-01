/**
 * Company-level outreach blocks: a company hold, an open CRM deal and an account a sales rep
 * owns stop new outreach but never an answer to someone who wrote to us.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { workspaces } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedPerson } from "../../testing/factories.js";
import { isBlockingReason, replyBlockers } from "../inbox/send.js";
import {
  checkContactable,
  companyBlockReasons,
  companyOutreachReasons,
  contactabilityReasons,
  OUTREACH_ONLY_REASONS,
} from "./contactable.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DAY = 86_400_000;

async function withSettings(ctx: TestContext, settings: Record<string, unknown>) {
  await ctx.db.update(workspaces).set({ settings }).where(eq(workspaces.id, ctx.workspace.id));
  await ctx.reloadWorkspace();
}

async function reasonsFor(ctx: TestContext, personId: string, channel: "email" | "linkedin") {
  return (await checkContactable(ctx, { personId, channel })).reasons;
}

describe("company outreach blocks", () => {
  it("blocks outreach while a company hold lasts, on every channel", async () => {
    const ctx = await createTestContext({ db: testDb });
    const now = ctx.clock.now();
    const company = await seedCompany(ctx, {
      country: "US",
      hold_until: new Date(now.getTime() + 30 * DAY),
      hold_reason: "Signed with a competitor until next month.",
    });
    const person = await seedPerson(ctx, {
      company_id: company.id,
      country: "US",
      linkedin_url: `https://www.linkedin.com/in/held-${company.id.slice(-6)}`,
    });
    expect(await reasonsFor(ctx, person.id, "email")).toEqual(["company_on_hold"]);
    expect(await reasonsFor(ctx, person.id, "linkedin")).toEqual(["company_on_hold"]);
    expect(await companyBlockReasons(ctx, company)).toEqual(["company_on_hold"]);

    ctx.clock.advance(31 * DAY);
    expect((await checkContactable(ctx, { personId: person.id, channel: "email" })).ok).toBe(true);
    expect(await companyBlockReasons(ctx, company)).toEqual([]);
  });

  it("ignores a hold that already ended", async () => {
    const ctx = await createTestContext({ db: testDb });
    const company = await seedCompany(ctx, {
      country: "US",
      hold_until: new Date(ctx.clock.now().getTime() - DAY),
    });
    const person = await seedPerson(ctx, { company_id: company.id, country: "US" });
    expect(await reasonsFor(ctx, person.id, "email")).toEqual([]);
  });

  it("blocks companies with an open CRM deal unless the workspace allows it", async () => {
    const ctx = await createTestContext({ db: testDb });
    const company = await seedCompany(ctx, { country: "US", crm_open_deal: true });
    const person = await seedPerson(ctx, { company_id: company.id, country: "US" });
    expect(await reasonsFor(ctx, person.id, "email")).toEqual(["company_open_deal"]);

    await withSettings(ctx, { crm: { allow_outreach_with_open_deal: true } });
    expect(await reasonsFor(ctx, person.id, "email")).toEqual([]);
  });

  it("blocks accounts a sales rep owns only when the workspace says so", async () => {
    const ctx = await createTestContext({ db: testDb });
    const company = await seedCompany(ctx, { country: "US", crm_owner: "Account Owner A" });
    const blankOwner = await seedCompany(ctx, { country: "US", crm_owner: "   " });
    const person = await seedPerson(ctx, { company_id: company.id, country: "US" });
    const other = await seedPerson(ctx, { company_id: blankOwner.id, country: "US" });
    expect(await reasonsFor(ctx, person.id, "email")).toEqual([]);

    await withSettings(ctx, { crm: { skip_owned_accounts: true } });
    expect(await reasonsFor(ctx, person.id, "email")).toEqual(["company_owned"]);
    expect(await reasonsFor(ctx, other.id, "email")).toEqual([]);
  });

  it("lists every company block together, after the status codes", async () => {
    const ctx = await createTestContext({
      db: testDb,
      settings: { crm: { skip_owned_accounts: true } },
    });
    const company = await seedCompany(ctx, {
      country: "US",
      status: "customer",
      hold_until: new Date(ctx.clock.now().getTime() + DAY),
      crm_open_deal: true,
      crm_owner: "Account Owner B",
    });
    const person = await seedPerson(ctx, { company_id: company.id, country: "US" });
    expect(await reasonsFor(ctx, person.id, "email")).toEqual([
      "company_customer",
      "company_on_hold",
      "company_open_deal",
      "company_owned",
    ]);
  });

  it("is pure: the caller passes the moment that decides a hold", async () => {
    const ctx = await createTestContext({ db: testDb });
    const settings = parseWorkspaceSettings({});
    const holdUntil = new Date("2026-10-01T00:00:00Z");
    const company = await seedCompany(ctx, { country: "US", hold_until: holdUntil });
    const person = await seedPerson(ctx, { company_id: company.id, country: "US" });
    const before = new Date("2026-09-30T23:59:59Z");
    expect(contactabilityReasons(person, company, "email", settings, before)).toEqual([
      "company_on_hold",
    ]);
    expect(contactabilityReasons(person, company, "email", settings, holdUntil)).toEqual([]);
    expect(companyOutreachReasons(null, settings, before)).toEqual([]);
  });
});

describe("answering someone who wrote to us", () => {
  it("is never blocked by a company hold, an open deal or an owned account", async () => {
    for (const reason of OUTREACH_ONLY_REASONS) expect(isBlockingReason(reason)).toBe(false);

    const ctx = await createTestContext({
      db: testDb,
      settings: { crm: { skip_owned_accounts: true } },
    });
    const company = await seedCompany(ctx, {
      country: "US",
      hold_until: new Date(ctx.clock.now().getTime() + 90 * DAY),
      crm_open_deal: true,
      crm_owner: "Account Owner C",
    });
    const person = await seedPerson(ctx, {
      company_id: company.id,
      country: "US",
      linkedin_url: `https://www.linkedin.com/in/writer-${company.id.slice(-6)}`,
    });
    expect((await checkContactable(ctx, { personId: person.id, channel: "email" })).ok).toBe(false);
    expect(await replyBlockers(ctx, person.id, "email")).toEqual([]);
    expect(await replyBlockers(ctx, person.id, "linkedin")).toEqual([]);
  });

  it("still stops for opt-outs at a held company", async () => {
    const ctx = await createTestContext({ db: testDb });
    const company = await seedCompany(ctx, {
      country: "US",
      hold_until: new Date(ctx.clock.now().getTime() + DAY),
    });
    const person = await seedPerson(ctx, {
      company_id: company.id,
      country: "US",
      status: "unsubscribed",
    });
    expect(await replyBlockers(ctx, person.id, "email")).toEqual(["person_unsubscribed"]);
  });
});
