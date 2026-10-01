import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signals } from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedCompany, seedMessage, seedPerson } from "../../../testing/factories.js";
import { collectorRun, html } from "../test-helpers.js";
import { detectTechnologies } from "./fingerprints.js";
import {
  createFirstPartyCollector,
  findDepartureSentence,
  firstPartyBounceHandler,
  firstPartyReplyHandler,
} from "./first-party.js";
import { createTechDetectCollector, diffTechnologies } from "./tech-detect.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => {
  ctx.recorded.events.length = 0;
  ctx.clock.set("2026-09-19T12:00:00Z");
});

describe("detectTechnologies", () => {
  it("finds tools in scripts, generator, headers, cookies and DNS", () => {
    const headers = new Headers({ server: "cloudflare", "set-cookie": "hubspotutk=abc; Path=/" });
    const found = detectTechnologies({
      html: html(
        '<script src="https://js.hs-scripts.com/123.js"></script><script src="https://widget.intercom.io/widget/x"></script>',
        '<meta name="generator" content="WordPress 6.9">',
      ),
      headers,
      mx: ["acme-com.mail.protection.outlook.com"],
      txt: ["v=spf1 include:spf.protection.outlook.com include:sendgrid.net -all"],
    });
    expect(found.map((tech) => tech.name)).toEqual([
      "Cloudflare",
      "HubSpot",
      "Intercom",
      "Microsoft 365",
      "SendGrid",
      "WordPress",
    ]);
    expect(
      detectTechnologies({ html: "<p>plain</p>", headers: new Headers(), mx: [], txt: [] }),
    ).toEqual([]);
  });
});

describe("diffTechnologies", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 8, n, 12));

  it("baselines, adopts at once and removes only after 7 days missing", () => {
    const first = diffTechnologies(null, ["HubSpot", "Stripe"], day(1));
    expect(first).toMatchObject({ adopted: [], removed: [] });
    const second = diffTechnologies(first.state, ["HubSpot", "Intercom"], day(2));
    expect(second.adopted).toEqual(["Intercom"]);
    expect(second.removed).toEqual([]);
    expect(second.state.missing_since).toEqual({ Stripe: day(2).toISOString() });
    const third = diffTechnologies(second.state, ["HubSpot", "Intercom"], day(5));
    expect(third.removed).toEqual([]);
    const fourth = diffTechnologies(third.state, ["HubSpot", "Intercom"], day(9));
    expect(fourth.removed).toEqual(["Stripe"]);
    expect(fourth.state.present).toEqual(["HubSpot", "Intercom"]);
    // A tool that comes back before confirmation is not removed.
    const back = diffTechnologies(second.state, ["HubSpot", "Intercom", "Stripe"], day(4));
    expect(back.state.missing_since).toEqual({});
  });
});

describe("tech_detect collector", () => {
  it("reports adoption, confirmed removal and competitors, never on a failed fetch", async () => {
    const company = await seedCompany(ctx, {
      domain: "td-one.example.com",
      website: "https://td-one.example.com",
    });
    let page = html('<script src="https://js.stripe.com/v3"></script>');
    ctx.fetch.route("https://td-one.example.com/", () => ({ body: page }));
    ctx.dns.set("td-one.example.com", {
      mx: ["aspmx.l.google.com"],
      txt: ["v=spf1 include:_spf.google.com ~all"],
    });
    const collector = createTechDetectCollector();
    const keywords = { tech: ["HubSpot", "Google Workspace"], competitors: ["Intercom"] };

    const baseline = await collector.collect(await collectorRun(ctx, company, { keywords }));
    expect(baseline.signals).toEqual([]);
    expect(ctx.dns.lookups).toEqual(["mx:td-one.example.com", "txt:td-one.example.com"]);
    expect(baseline.evidence[0]?.text).toContain("MX: aspmx.l.google.com");

    page = html(
      '<script src="https://js.hs-scripts.com/1.js"></script><script src="https://widget.intercom.io/w"></script>',
    );
    ctx.dns.set("td-one.example.com", {
      mx: ["example-com.mail.protection.outlook.com"],
      txt: ["v=spf1 include:spf.protection.outlook.com -all"],
    });
    const changed = await collector.collect(await collectorRun(ctx, company, { keywords }));
    // Microsoft 365 is new too, but not in the tech keywords: no signal for it.
    expect(changed.signals.map((s) => [s.definition_key, s.title, s.strength])).toEqual([
      ["tech_adopted", "Started using HubSpot", 1],
      ["competitor_mention", "Started using Intercom (a competitor)", 0.8],
    ]);

    ctx.fetch.route("https://td-one.example.com/", { status: 503, body: "down" });
    const failed = await collector.collect(await collectorRun(ctx, company, { keywords }));
    expect(failed.notes).toEqual(["tech_detect: home page returned 503"]);

    ctx.fetch.route("https://td-one.example.com/", () => ({ body: page }));
    ctx.clock.advanceBy({ days: 8 });
    const later = await collector.collect(await collectorRun(ctx, company, { keywords }));
    expect(later.signals).toEqual([
      expect.objectContaining({
        definition_key: "tech_removed",
        title: "Stopped using Google Workspace",
        evidence_url: "https://td-one.example.com/",
      }),
    ]);
  });
});

describe("first_party", () => {
  it("finds departure sentences in several languages and ignores normal out-of-office", () => {
    expect(
      findDepartureSentence(
        "Thanks for your email. Dana Reyes is no longer with Harbor Dental. Please contact info@example.com.",
      ),
    ).toBe("Dana Reyes is no longer with Harbor Dental.");
    expect(findDepartureSentence("Herr Becker ist nicht mehr bei uns tätig.")).toMatch(
      /nicht mehr bei/,
    );
    expect(findDepartureSentence("Elle ne fait plus partie de l'équipe.")).toMatch(/ne fait plus/);
    expect(
      findDepartureSentence("I am out of office until Monday with limited access to email."),
    ).toBeNull();
    expect(findDepartureSentence(null)).toBeNull();
  });

  it("records job_change on the person from an auto-reply, once", async () => {
    const company = await seedCompany(ctx, { name: "Harbor Dental" });
    const person = await seedPerson(ctx, { company_id: company.id, full_name: "Dana Reyes" });
    const message = await seedMessage(ctx, {
      person_id: person.id,
      company_id: company.id,
      direction: "inbound",
      status: "received",
      subject: "Automatic reply",
      body_text:
        "Hello. Dana Reyes is no longer with Harbor Dental. For scheduling, write to front desk.",
    });
    const event = {
      id: "evt_1",
      type: "reply.received" as const,
      workspaceId: ctx.workspace.id,
      subject: null,
      occurredAt: new Date("2026-09-19T10:00:00Z"),
      data: {
        message_id: message.id,
        thread_id: "thr_1",
        person_id: person.id,
        campaign_id: null,
        channel: "email" as const,
      },
    };
    await firstPartyReplyHandler.handler(ctx.jobContext(), event);
    await firstPartyReplyHandler.handler(ctx.jobContext(), event);
    const rows = await ctx.db.select().from(signals).where(eq(signals.person_id, person.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      definition_key: "job_change",
      company_id: null,
      title: "Dana Reyes appears to have left Harbor Dental",
      evidence_url: `openoutbound://messages/${message.id}`,
      evidence_excerpt: "Dana Reyes is no longer with Harbor Dental.",
      strength: 0.5,
      source: "first_party",
    });
    expect(ctx.emitted("signal.detected")).toHaveLength(1);
  });

  it("uses bounce reasons and ignores ordinary bounces", async () => {
    const person = await seedPerson(ctx);
    const bounce = (reason: string) => ({
      id: "evt_2",
      type: "message.bounced" as const,
      workspaceId: ctx.workspace.id,
      subject: null,
      occurredAt: new Date("2026-09-19T10:00:00Z"),
      data: {
        message_id: "msg_1",
        person_id: person.id,
        email: person.email ?? "",
        bounce_type: "hard" as const,
        reason,
      },
    });
    await firstPartyBounceHandler.handler(ctx.jobContext(), bounce("550 5.1.1 User unknown"));
    expect(
      await ctx.db.select().from(signals).where(eq(signals.person_id, person.id)),
    ).toHaveLength(0);
    await firstPartyBounceHandler.handler(
      ctx.jobContext(),
      bounce("550 5.1.1 The recipient is no longer employed by this organization."),
    );
    expect(
      await ctx.db.select().from(signals).where(eq(signals.person_id, person.id)),
    ).toHaveLength(1);
  });

  it("offers recent inbound messages as evidence", async () => {
    const company = await seedCompany(ctx);
    await seedMessage(ctx, {
      company_id: company.id,
      direction: "inbound",
      status: "received",
      subject: "Re: forecasting",
      body_text: "We are evaluating tools this quarter.",
      received_at: new Date("2026-09-10T10:00:00Z"),
    });
    await seedMessage(ctx, { company_id: company.id, direction: "outbound", status: "sent" });
    const out = await createFirstPartyCollector().collect(await collectorRun(ctx, company));
    expect(out.evidence).toEqual([
      expect.objectContaining({
        title: "Re: forecasting",
        text: "We are evaluating tools this quarter.",
        collector: "first_party",
      }),
    ]);
  });
});
