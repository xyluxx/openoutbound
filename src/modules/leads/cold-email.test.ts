/**
 * The cold email check's record on a person: what a stored verdict means for contactability,
 * how long it stands, and how the engine describes an address to the provider.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { type EmailClearance, people, workspaces } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedPerson } from "../../testing/factories.js";
import {
  addressSourceOf,
  cachedClearance,
  clearanceInputs,
  clearanceReasons,
  currentClearance,
  recipientNameOf,
  recordEmailClearance,
} from "./cold-email.js";
import { checkContactable } from "./contactable.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const DAY = 86_400_000;
const NOW = new Date("2026-09-19T12:00:00.000Z");
const EMAIL = "dana@harbor.example.com";

function clearance(overrides: Partial<EmailClearance> = {}): EmailClearance {
  return {
    provider: "precleared",
    email: EMAIL,
    verdict: "consent_needed",
    reason: "The recipient appears to be a sole trader.",
    next_step: "Get consent first.",
    receipt_id: "rcpt_01k6a3v0q8x3m2n4p5r6s7t8v1",
    checked_at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    inputs: "abc",
    ...overrides,
  };
}

const settings = (mode: "hold" | "warn" | "off" = "hold") =>
  parseWorkspaceSettings({ compliance: { cold_email_check: { mode } } });

describe("clearanceReasons", () => {
  it("holds consent_needed and blocked verdicts in mode hold, for 30 days", () => {
    const person = { email: EMAIL, email_clearance: clearance(), custom: {} };
    expect(clearanceReasons(person, settings(), NOW)).toEqual(["cold_email_consent_needed"]);
    const blocked = { ...person, email_clearance: clearance({ verdict: "blocked" }) };
    expect(clearanceReasons(blocked, settings(), NOW)).toEqual(["cold_email_blocked"]);
    const stale = {
      ...person,
      email_clearance: clearance({ checked_at: new Date(NOW.getTime() - 31 * DAY).toISOString() }),
    };
    expect(clearanceReasons(stale, settings(), NOW)).toEqual([]);
  });

  it("never holds ok_to_email or unknown, another address, or in modes warn and off", () => {
    const ok = { email: EMAIL, email_clearance: clearance({ verdict: "ok_to_email" }), custom: {} };
    expect(clearanceReasons(ok, settings(), NOW)).toEqual([]);
    const unknown = { ...ok, email_clearance: clearance({ verdict: "unknown" }) };
    expect(clearanceReasons(unknown, settings(), NOW)).toEqual([]);
    const moved = { email: "dana@newjob.example.com", email_clearance: clearance(), custom: {} };
    expect(clearanceReasons(moved, settings(), NOW)).toEqual([]);
    const held = { email: EMAIL, email_clearance: clearance(), custom: {} };
    expect(clearanceReasons(held, settings("warn"), NOW)).toEqual([]);
    expect(clearanceReasons(held, settings("off"), NOW)).toEqual([]);
  });

  it("lets recorded consent satisfy consent_needed, never blocked", () => {
    const consented = { email: EMAIL, email_clearance: clearance(), custom: { consent: true } };
    expect(clearanceReasons(consented, settings(), NOW)).toEqual([]);
    const blocked = { ...consented, email_clearance: clearance({ verdict: "blocked" }) };
    expect(clearanceReasons(blocked, settings(), NOW)).toEqual(["cold_email_blocked"]);
  });

  it("reaches the leads contactability check, enrollment and the views", async () => {
    const ctx: TestContext = await createTestContext({ db: testDb });
    const person = await seedPerson(ctx, { email: EMAIL, country: "US" });
    await recordEmailClearance(ctx, person.id, clearance());
    expect(await checkContactable(ctx, { personId: person.id, channel: "email" })).toEqual({
      ok: false,
      reasons: ["cold_email_consent_needed"],
    });
    // An email verdict says nothing about LinkedIn.
    expect(
      (await checkContactable(ctx, { personId: person.id, channel: "linkedin" })).reasons,
    ).not.toContain("cold_email_consent_needed");
    await ctx.db
      .update(workspaces)
      .set({ settings: { compliance: { cold_email_check: { mode: "off" } } } })
      .where(eq(workspaces.id, ctx.workspace.id));
    await ctx.reloadWorkspace();
    expect((await checkContactable(ctx, { personId: person.id, channel: "email" })).ok).toBe(true);
    const [row] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(row?.email_clearance).toMatchObject({ verdict: "consent_needed" });
  });
});

describe("the stored verdict as a cache", () => {
  it("answers the same question for 30 days, never unknown or other facts", () => {
    const person = { email: EMAIL, email_clearance: clearance({ inputs: "abc" }) };
    expect(cachedClearance(person, "abc", NOW)?.verdict).toBe("consent_needed");
    expect(cachedClearance(person, "other", NOW)).toBeNull();
    const unknown = { email: EMAIL, email_clearance: clearance({ verdict: "unknown" }) };
    expect(cachedClearance(unknown, "abc", NOW)).toBeNull();
    expect(currentClearance(unknown, NOW)?.verdict).toBe("unknown");
    const old = {
      email: EMAIL,
      email_clearance: clearance({ checked_at: new Date(NOW.getTime() - 31 * DAY).toISOString() }),
    };
    expect(cachedClearance(old, "abc", NOW)).toBeNull();
    expect(currentClearance({ email: EMAIL, email_clearance: null }, NOW)).toBeNull();
  });

  it("fingerprints every fact sent with the address, nothing else", () => {
    const base = {
      sender_country: "GB" as const,
      address_source: "published" as const,
      company_name: "Harbor Dental Ltd",
      recipient_name: "Dana Reyes",
      recipient_country: "GB",
    };
    expect(clearanceInputs(base)).toBe(clearanceInputs({ ...base }));
    expect(clearanceInputs(base)).not.toBe(clearanceInputs({ ...base, sender_country: "US" }));
    expect(clearanceInputs(base)).not.toBe(clearanceInputs({ ...base, address_source: "bought" }));
    expect(clearanceInputs(base)).not.toBe(
      clearanceInputs({ ...base, company_number: "01234567" }),
    );
    expect(clearanceInputs(base)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("what the provider is told about an address", () => {
  it("maps the address source without assuming an address was published", () => {
    expect(addressSourceOf({ email_source: "https://harbor.example.com/team", custom: {} })).toBe(
      "published",
    );
    expect(addressSourceOf({ email_source: "website", custom: {} })).toBe("published");
    expect(
      addressSourceOf({ email_source: "import", custom: { publication_url: "https://x.example" } }),
    ).toBe("published");
    expect(addressSourceOf({ email_source: "apollo", custom: {} })).toBe("bought");
    expect(addressSourceOf({ email_source: "hunter", custom: {} })).toBe("bought");
    expect(addressSourceOf({ email_source: "csv", custom: {} })).toBe("unknown");
    expect(addressSourceOf({ email_source: "manual", custom: {} })).toBe("unknown");
    expect(addressSourceOf({ email_source: "pattern_guess", custom: {} })).toBe("unknown");
    expect(addressSourceOf({ email_source: null, custom: {} })).toBe("unknown");
  });

  it("names the person, never by their address", () => {
    expect(recipientNameOf({ full_name: "Dana Reyes", first_name: null, last_name: null })).toBe(
      "Dana Reyes",
    );
    expect(recipientNameOf({ full_name: null, first_name: "Dana", last_name: "Reyes" })).toBe(
      "Dana Reyes",
    );
    expect(recipientNameOf({ full_name: null, first_name: null, last_name: null })).toBeNull();
  });
});
