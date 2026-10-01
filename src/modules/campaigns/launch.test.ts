/**
 * Launch checklist compliance items: reply sync (IMAP) on sender mailboxes, the mandatory
 * postal address, the unsubscribe link that needs a public https base URL, and the AI brain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { type SeedStep, seedCampaign, seedMailbox } from "../../testing/factories.js";
import { PUBLIC_BASE_URL_FIX } from "../email/service.js";
import { isPublicHttpsUrl, launchChecklist } from "./launch.js";
import { launchCampaign } from "./operations/lifecycle.js";
import { loadCampaign } from "./repo.js";

const POSTAL = "1 Example Way, Austin, TX";
const EMAIL: SeedStep = {
  type: "email",
  config: { style: "exact", subject: "hello", body: "Hi, worth a look?" },
};
const IMAP = { host: "imap.example.org", port: 993, secure: true, user: "sam@example.org" };
const SMTP = { host: "smtp.example.org", port: 465, secure: true, user: "sam@example.org" };

let db: TestDb;
const contexts: TestContext[] = [];
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await Promise.all(contexts.map((ctx) => ctx.close()));
  await db.close();
});

async function context(
  options: { baseUrl?: string; sandbox?: boolean; settings?: WorkspaceSettingsInput } = {},
): Promise<TestContext> {
  const ctx = await createTestContext({
    db,
    sandbox: options.sandbox ?? false,
    settings: options.settings ?? { company: { name: "Brightline", postal_address: POSTAL } },
    ...(options.baseUrl ? { config: { baseUrl: options.baseUrl } } : {}),
  });
  contexts.push(ctx);
  return ctx;
}

/** A real (non-sandbox) password mailbox; pass imap: null for one that cannot read replies. */
function realMailbox(ctx: TestContext, email: string, imap: typeof IMAP | null) {
  return seedMailbox(ctx, {
    email,
    auth_type: "password",
    provider_label: "custom",
    smtp: SMTP,
    imap,
  });
}

async function checklist(ctx: TestContext, mailboxIds: string[], steps: SeedStep[] = [EMAIL]) {
  const { campaign } = await seedCampaign(ctx, {
    settings: { senders: { mailbox_ids: mailboxIds } },
    steps,
  });
  const result = await launchChecklist(ctx, await loadCampaign(ctx, campaign.id));
  const byKey = new Map(result.items.map((entry) => [entry.key, entry]));
  return { campaign, result, item: (key: string) => byKey.get(key) };
}

describe("reply sync on sender mailboxes", () => {
  it("fails when a sender mailbox has no IMAP and names it with a fix", async () => {
    const ctx = await context({ baseUrl: "https://outreach.example.com" });
    const reads = await realMailbox(ctx, "reads@example.org", IMAP);
    const blind = await realMailbox(ctx, "blind@example.org", null);
    const { result, item } = await checklist(ctx, [reads.id, blind.id]);
    expect(result.ready).toBe(false);
    expect(item("reply_sync")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("blind@example.org"),
      fix: expect.stringContaining("manage_mailboxes action update (imap_host, imap_port)"),
    });
    expect(item("reply_sync")?.detail).not.toContain("reads@example.org");
  });

  it("passes when every sender mailbox reads replies", async () => {
    const ctx = await context({ baseUrl: "https://outreach.example.com" });
    const reads = await realMailbox(ctx, "reads@example.org", IMAP);
    const { result, item } = await checklist(ctx, [reads.id]);
    expect(item("reply_sync")?.status).toBe("pass");
    expect(result.items.filter((entry) => entry.status === "fail")).toEqual([]);
  });

  it("passes sandbox mailboxes and sandbox workspaces", async () => {
    const ctx = await context();
    const simulated = await seedMailbox(ctx);
    expect((await checklist(ctx, [simulated.id])).item("reply_sync")?.status).toBe("pass");

    const sandbox = await context({ sandbox: true });
    const blind = await realMailbox(sandbox, "blind@example.org", null);
    expect((await checklist(sandbox, [blind.id])).item("reply_sync")?.status).toBe("pass");
  });

  it("blocks the launch operation", async () => {
    const ctx = await context({ baseUrl: "https://outreach.example.com" });
    const blind = await realMailbox(ctx, "blind@example.org", null);
    const { campaign } = await checklist(ctx, [blind.id]);
    await expect(launchCampaign.handler(ctx, { campaign_id: campaign.id })).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("Replies are read"),
    });
  });
});

describe("postal address", () => {
  it("is mandatory for email campaigns even when the footer setting is off", async () => {
    const ctx = await context({
      settings: {
        company: { name: "Brightline", postal_address: "  " },
        compliance: { include_postal_address: false },
      },
    });
    const mailbox = await seedMailbox(ctx);
    const { result, item } = await checklist(ctx, [mailbox.id]);
    expect(result.ready).toBe(false);
    expect(item("postal_address")).toMatchObject({
      status: "fail",
      fix: 'Ask the human to change settings.company.postal_address (openoutbound workspaces update); to suggest it, use manage_strategy action propose (operation workspaces.update, input {"settings":{"company":{"postal_address":"<postal address>"}}}).',
    });
  });

  it("passes when set and is not asked for LinkedIn-only campaigns", async () => {
    const ctx = await context();
    const mailbox = await seedMailbox(ctx);
    expect((await checklist(ctx, [mailbox.id])).item("postal_address")?.status).toBe("pass");

    const noAddress = await context({ settings: { company: { name: "Brightline" } } });
    const linkedinOnly = await checklist(noAddress, [], [{ type: "linkedin_visit" }]);
    expect(linkedinOnly.item("postal_address")).toBeUndefined();
    expect(linkedinOnly.item("unsubscribe_link")).toBeUndefined();
  });
});

describe("unsubscribe link", () => {
  it("fails in a real workspace while the base URL is localhost, http or private", async () => {
    for (const base of [
      "http://localhost:7331",
      "http://outreach.example.com",
      "https://10.1.2.3",
      "https://engine.internal",
    ]) {
      const ctx = await context({ baseUrl: base });
      const mailbox = await realMailbox(ctx, "sam@example.org", IMAP);
      const { result, item } = await checklist(ctx, [mailbox.id]);
      expect(item("unsubscribe_link")).toEqual({
        key: "unsubscribe_link",
        label: "Unsubscribe link",
        status: "fail",
        detail: `OPENOUTBOUND_BASE_URL (${base}) is not a public https address, so the unsubscribe link in every email would not work. Emails of this campaign would be held until it is set.`,
        fix: PUBLIC_BASE_URL_FIX,
      });
      expect(result.ready).toBe(false);
    }
  });

  it("blocks the launch operation with the fix as the hint", async () => {
    const ctx = await context({ baseUrl: "http://localhost:7331" });
    const mailbox = await realMailbox(ctx, "sam@example.org", IMAP);
    const { campaign } = await checklist(ctx, [mailbox.id]);
    await expect(launchCampaign.handler(ctx, { campaign_id: campaign.id })).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("Unsubscribe link"),
      hint: PUBLIC_BASE_URL_FIX,
    });
  });

  it("passes with a public https base URL, in sandbox workspaces and with sandbox mailboxes", async () => {
    const ctx = await context({ baseUrl: "https://outreach.example.com" });
    const mailbox = await realMailbox(ctx, "sam@example.org", IMAP);
    expect((await checklist(ctx, [mailbox.id])).item("unsubscribe_link")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("https://outreach.example.com"),
    });

    const sandbox = await context({ sandbox: true });
    const simulated = await seedMailbox(sandbox);
    expect((await checklist(sandbox, [simulated.id])).item("unsubscribe_link")).toMatchObject({
      status: "pass",
      detail: "Sandbox: unsubscribe links are simulated.",
    });

    // A real workspace that only sends through sandbox mailboxes reaches the simulator.
    const local = await context({ baseUrl: "http://localhost:7331" });
    const fake = await seedMailbox(local);
    expect((await checklist(local, [fake.id])).item("unsubscribe_link")?.status).toBe("pass");
  });

  it("recognizes public https URLs", () => {
    expect(isPublicHttpsUrl("https://outreach.example.com")).toBe(true);
    expect(isPublicHttpsUrl("https://outreach.example.com:8443/base")).toBe(true);
    expect(isPublicHttpsUrl("http://outreach.example.com")).toBe(false);
    expect(isPublicHttpsUrl("https://localhost")).toBe(false);
    expect(isPublicHttpsUrl("https://192.168.1.20")).toBe(false);
    expect(isPublicHttpsUrl("not a url")).toBe(false);
  });
});

describe("AI brain", () => {
  it("says AI-written steps wait for a brain and how to configure one", async () => {
    const ctx = await context({ baseUrl: "https://outreach.example.com" });
    const mailbox = await realMailbox(ctx, "sam@example.org", IMAP);
    const { item } = await checklist(ctx, [mailbox.id], [{ type: "email" }]);
    expect(item("brain")).toEqual({
      key: "brain",
      label: "AI brain",
      status: "warn",
      detail:
        "No AI brain is configured for this workspace, so AI-written steps wait (nothing is sent or failed) until one is.",
      fix: "Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in the engine's .env and restart `openoutbound serve`, or store a key with manage_providers action set (slot brain). Exact templates need no brain.",
    });
  });
});

describe("AI cost estimate", () => {
  /** Two AI-written emails at 30 new leads a day: 2 x $0.012 x 30 = $0.72 a day for real. */
  async function launchPreview(ctx: TestContext) {
    const mailbox = await seedMailbox(ctx);
    const { campaign } = await seedCampaign(ctx, {
      settings: {
        senders: { mailbox_ids: [mailbox.id] },
        daily_new_leads: 30,
        writing: { instructions: "Offer the audit." },
      },
      steps: [{ type: "email" }, { type: "email", delay_days: 3 }],
    });
    return (await launchCampaign.handler(ctx.with({ request: { dryRun: true } }), {
      campaign_id: campaign.id,
    })) as {
      preview: { estimates: { est_ai_cost_usd_per_lead: number } };
      estimated_cost: { usd: number; note: string };
    };
  }

  it("shows what the AI would cost a day in a real workspace", async () => {
    const result = await launchPreview(await context({ baseUrl: "https://outreach.example.com" }));
    expect(result.estimated_cost).toEqual({
      usd: 0.72,
      note: "Rough AI cost per day at the daily_new_leads pace (writing and checking).",
    });
    expect(result.preview.estimates.est_ai_cost_usd_per_lead).toBe(0.024);
  });

  it("shows zero in a sandbox, with what it would cost for real", async () => {
    const result = await launchPreview(await context({ sandbox: true }));
    expect(result.estimated_cost).toEqual({
      usd: 0,
      note: "Sandbox: the fake AI brain costs nothing. With a real AI brain this would cost about $0.72 a day at the daily_new_leads pace (writing and checking).",
    });
    expect(result.preview.estimates.est_ai_cost_usd_per_lead).toBe(0);
  });
});

describe("mailbox warm-up", () => {
  const QUIET_RAMP = { enabled: true, start: 5, increment: 5, every_days: 7, delay_days: 14 };

  it("warns with the first sending day when every sender is in its quiet weeks", async () => {
    const ctx = await context({ baseUrl: "https://outreach.example.com" });
    const now = ctx.clock.now();
    const fresh = await seedMailbox(ctx, {
      email: "fresh@example.org",
      auth_type: "password",
      provider_label: "custom",
      smtp: SMTP,
      imap: IMAP,
      ramp: QUIET_RAMP,
      created_at: now,
    });
    const { result, item } = await checklist(ctx, [fresh.id]);
    const firstDay = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    expect(item("warmup")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining(firstDay),
      fix: expect.stringContaining("warmed_up: true"),
    });
    // A warning, not a blocker: launching now simply waits.
    expect(item("mailboxes")?.status).toBe("pass");
    expect(result.items.filter((entry) => entry.status === "fail").map((e) => e.key)).toEqual([]);
  });

  it("says nothing once any sender may send today", async () => {
    const ctx = await context({ baseUrl: "https://outreach.example.com" });
    const now = ctx.clock.now();
    const fresh = await seedMailbox(ctx, {
      email: "fresh2@example.org",
      auth_type: "password",
      provider_label: "custom",
      smtp: SMTP,
      imap: IMAP,
      ramp: QUIET_RAMP,
      created_at: now,
    });
    const warm = await seedMailbox(ctx, {
      email: "warm@example.org",
      auth_type: "password",
      provider_label: "custom",
      smtp: SMTP,
      imap: IMAP,
      ramp: { ...QUIET_RAMP, start: 15, delay_days: 0 },
      created_at: now,
    });
    const { item } = await checklist(ctx, [fresh.id, warm.id]);
    expect(item("warmup")).toBeUndefined();
  });
});
