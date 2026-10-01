import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { mailboxes, problems } from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedMailbox } from "../../testing/factories.js";
import { DNS_DAILY_JOB, dnsDailySchedule, runDailyDnsCheck } from "./dns-daily-job.js";
import { module as emailModule } from "./index.js";

vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const DOMAIN = "brand.example.com";
const OTHER = "outreach.example.org";

const GREEN = {
  mx: ["aspmx.l.google.com"],
  txt: ["v=spf1 include:_spf.google.com ~all"],
};
const NO_SPF = { mx: ["aspmx.l.google.com"], txt: [] };
const NO_MX_NO_SPF = { mx: [], txt: [] };
const DKIM = `google._domainkey.${DOMAIN}`;
const DKIM_KEY = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";
const DMARC = `_dmarc.${DOMAIN}`;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.mocked(notify).mockClear();
});

async function setup(settings: WorkspaceSettingsInput = {}, options: { sandbox?: boolean } = {}) {
  const ctx: TestContext = await createTestContext({
    db,
    settings,
    ...(options.sandbox ? { sandbox: true } : {}),
  });
  const mailbox = (email: string, status: "active" | "warming" | "paused" = "active") =>
    seedMailbox(ctx, { email, status, provider_label: "google", auth_type: "oauth_google" });
  const first = await mailbox(`dana@${DOMAIN}`);
  const second = await mailbox(`lee@${DOMAIN}`, "warming");
  const paused = await mailbox(`old@${DOMAIN}`, "paused");
  const other = await mailbox(`sam@${OTHER}`);
  ctx.dns.set(DOMAIN, GREEN);
  ctx.dns.set(OTHER, GREEN);
  return { ctx, first, second, paused, other };
}

async function dnsProblems(ctx: TestContext) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "dns_failed")));
}

async function stored(ctx: TestContext, id: string) {
  const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return row;
}

describe("daily DNS check", () => {
  it("runs daily at 06:17 UTC per workspace", () => {
    expect(dnsDailySchedule).toMatchObject({
      cron: "17 6 * * *",
      job: DNS_DAILY_JOB,
      perWorkspace: true,
    });
    expect(emailModule.schedules).toContain(dnsDailySchedule);
    expect(emailModule.jobs?.map((job) => job.name)).toContain(DNS_DAILY_JOB);
  });

  it("stores each domain's result on its mailboxes like check_dns", async () => {
    const { ctx, first, paused, other } = await setup();
    const result = await runDailyDnsCheck(ctx);
    expect(result.skipped).toBeNull();
    expect(result.domains.map((row) => [row.domain, row.action, row.mailboxes_updated])).toEqual([
      [DOMAIN, "ok", 3],
      [OTHER, "ok", 1],
    ]);
    const row = await stored(ctx, first.id);
    expect(row?.dns).toMatchObject({
      domain: DOMAIN,
      mx: true,
      spf: true,
      statuses: { mx: "green", spf: "green" },
    });
    expect((await stored(ctx, paused.id))?.dns?.checked_at).toBe(row?.dns?.checked_at);
    expect((await stored(ctx, other.id))?.dns?.domain).toBe(OTHER);
    expect(await dnsProblems(ctx)).toHaveLength(0);
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });

  it("opens dns_failed, emits per sending mailbox and notifies when a passing record turns red", async () => {
    const { ctx, first, second, paused } = await setup();
    await runDailyDnsCheck(ctx);
    ctx.dns.set(DOMAIN, NO_SPF);
    ctx.clock.advanceBy({ days: 1 });

    const result = await runDailyDnsCheck(ctx);
    expect(result.domains.find((row) => row.domain === DOMAIN)).toMatchObject({
      action: "failed",
      failed: ["spf"],
      overall: "red",
    });
    const [problem] = await dnsProblems(ctx);
    expect(problem).toMatchObject({
      severity: "high",
      owner: "person",
      status: "open",
      title: `SPF failed for ${DOMAIN}`,
      dedupe_key: `dns_failed:${DOMAIN}`,
      subject_type: "domain",
      subject_id: DOMAIN,
    });
    expect(problem?.reason).toContain("No SPF record.");
    expect(problem?.reason).toContain("The mailboxes keep sending.");
    expect(problem?.remedy).toContain(`SPF: Add a TXT record on ${DOMAIN}`);
    expect(problem?.remedy).toContain("include:_spf.google.com");
    expect(problem?.remedy).toContain("run manage_mailboxes action check_dns");

    const events = ctx.emitted("mailbox.dns_failed");
    expect(events.map((event) => event.data.mailbox_id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(events[0]?.data).toMatchObject({ domain: DOMAIN, failed: ["spf"] });
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0]?.[1]).toMatchObject({
      title: `DNS check failed for ${DOMAIN}: SPF`,
      event: "mailbox.dns_failed",
    });

    // Never pauses a mailbox.
    expect((await stored(ctx, first.id))?.status).toBe("active");
    expect((await stored(ctx, second.id))?.status).toBe("warming");
    expect((await stored(ctx, paused.id))?.dns?.statuses?.spf).toBe("red");
  });

  it("keeps one problem while the record stays red, then resolves it when it passes", async () => {
    const { ctx } = await setup();
    await runDailyDnsCheck(ctx);
    ctx.dns.set(DOMAIN, NO_SPF);
    await runDailyDnsCheck(ctx);
    const opened = ctx.emitted("mailbox.dns_failed").length;

    const again = await runDailyDnsCheck(ctx);
    expect(again.domains.find((row) => row.domain === DOMAIN)?.action).toBe("still_failed");
    expect(await dnsProblems(ctx)).toHaveLength(1);
    expect(ctx.emitted("mailbox.dns_failed")).toHaveLength(opened);
    expect(ctx.emitted("problem.opened")).toHaveLength(1);
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);

    // Another record failing too updates the same problem and alerts again.
    ctx.dns.set(DOMAIN, NO_MX_NO_SPF);
    const worse = await runDailyDnsCheck(ctx);
    expect(worse.domains.find((row) => row.domain === DOMAIN)).toMatchObject({
      action: "failed",
      failed: ["mx", "spf"],
    });
    const [problem] = await dnsProblems(ctx);
    expect(problem?.title).toBe(`MX and SPF failed for ${DOMAIN}`);
    expect(await dnsProblems(ctx)).toHaveLength(1);
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(2);

    ctx.dns.set(DOMAIN, GREEN);
    const fixed = await runDailyDnsCheck(ctx);
    expect(fixed.domains.find((row) => row.domain === DOMAIN)?.action).toBe("recovered");
    const [resolved] = await dnsProblems(ctx);
    expect(resolved?.status).toBe("resolved");
    expect(ctx.emitted("problem.resolved")).toHaveLength(1);
  });

  it("alerts when DKIM or DMARC stops passing or SPF gets a second record, and resolves when they pass", async () => {
    const { ctx, first } = await setup();
    ctx.dns.set(DKIM, { txt: [DKIM_KEY] });
    ctx.dns.set(DMARC, { txt: ["v=DMARC1; p=quarantine"] });
    expect((await runDailyDnsCheck(ctx)).domains[0]).toMatchObject({
      domain: DOMAIN,
      overall: "green",
      action: "ok",
    });

    // The DKIM key is gone and a second SPF record appeared: both yellow, never red.
    ctx.dns.set(DKIM, { txt: [] });
    ctx.dns.set(DOMAIN, { ...GREEN, txt: [...GREEN.txt, "v=spf1 include:mail.example.net ~all"] });
    ctx.clock.advanceBy({ days: 1 });
    expect((await runDailyDnsCheck(ctx)).domains[0]).toMatchObject({
      overall: "yellow",
      action: "failed",
      failed: ["spf", "dkim"],
    });
    const [problem] = await dnsProblems(ctx);
    expect(problem).toMatchObject({ status: "open", title: `SPF and DKIM failed for ${DOMAIN}` });
    expect(problem?.reason).toContain(
      "SPF is yellow: SPF record found, but more than one SPF record",
    );
    expect(problem?.reason).toContain("DKIM is yellow: No DKIM key at the common selectors");
    expect(ctx.emitted("mailbox.dns_failed")[0]?.data).toMatchObject({ failed: ["spf", "dkim"] });
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);

    // DMARC weakened a day later: the same problem names it too, and it alerts again.
    ctx.dns.set(DMARC, { txt: ["v=DMARC1; p=none"] });
    ctx.clock.advanceBy({ days: 1 });
    expect((await runDailyDnsCheck(ctx)).domains[0]).toMatchObject({
      action: "failed",
      failed: ["spf", "dkim", "dmarc"],
    });
    expect(await dnsProblems(ctx)).toHaveLength(1);
    expect((await dnsProblems(ctx))[0]?.reason).toContain("New since the last check: DMARC.");
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(2);

    // Unchanged the next day: no new alert, and the mailbox keeps sending.
    ctx.clock.advanceBy({ days: 1 });
    expect((await runDailyDnsCheck(ctx)).domains[0]?.action).toBe("still_failed");
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(2);
    expect((await stored(ctx, first.id))?.status).toBe("active");

    ctx.dns.set(DOMAIN, GREEN);
    ctx.dns.set(DKIM, { txt: [DKIM_KEY] });
    ctx.dns.set(DMARC, { txt: ["v=DMARC1; p=quarantine"] });
    ctx.clock.advanceBy({ days: 1 });
    expect((await runDailyDnsCheck(ctx)).domains[0]).toMatchObject({
      overall: "green",
      action: "recovered",
      failed: [],
    });
    const [resolved] = await dnsProblems(ctx);
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: `The daily DNS check found SPF, DKIM and DMARC passing again for ${DOMAIN}.`,
    });
  });

  it("raises no alarm when a lookup fails, and compares the next check with what was known", async () => {
    const { ctx, first } = await setup();
    ctx.dns.set(DMARC, { txt: ["v=DMARC1; p=quarantine"] });
    await runDailyDnsCheck(ctx);
    const lookup = ctx.dns.resolveTxt;
    const timeout = vi.spyOn(ctx.dns, "resolveTxt").mockImplementation(async (name) => {
      if (name === DMARC) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      return lookup(name);
    });
    ctx.clock.advanceBy({ days: 1 });
    expect((await runDailyDnsCheck(ctx)).domains[0]?.action).toBe("ok");
    expect(await dnsProblems(ctx)).toHaveLength(0);
    expect((await stored(ctx, first.id))?.dns?.statuses?.dmarc).toBe("green");

    // The record really went away meanwhile: the next check still sees the change.
    timeout.mockRestore();
    ctx.dns.set(DMARC, { txt: [] });
    ctx.clock.advanceBy({ days: 1 });
    expect((await runDailyDnsCheck(ctx)).domains[0]).toMatchObject({
      action: "failed",
      failed: ["dmarc"],
    });
  });

  it("alerts for a domain that was never checked and is red", async () => {
    const { ctx } = await setup();
    ctx.dns.set(OTHER, NO_SPF);
    const result = await runDailyDnsCheck(ctx);
    expect(result.domains.find((row) => row.domain === OTHER)?.action).toBe("failed");
    expect((await dnsProblems(ctx)).map((row) => row.dedupe_key)).toEqual([`dns_failed:${OTHER}`]);
  });

  it("does not alert for a stored red result from before", async () => {
    const { ctx, other } = await setup();
    // A result stored before per-check statuses existed: SPF did not pass, overall red.
    await ctx.db
      .update(mailboxes)
      .set({
        dns: {
          checked_at: "2026-09-18T06:17:00.000Z",
          domain: OTHER,
          overall: "red",
          mx: true,
          spf: false,
          dkim: false,
          dmarc: false,
          issues: ["SPF: No SPF record."],
        },
      })
      .where(eq(mailboxes.id, other.id));
    ctx.dns.set(OTHER, NO_SPF);
    const result = await runDailyDnsCheck(ctx);
    expect(result.domains.find((row) => row.domain === OTHER)?.action).toBe("still_failed");
    expect(await dnsProblems(ctx)).toHaveLength(0);
  });

  it("resolves the problem of a domain that no longer has a sending mailbox", async () => {
    const { ctx, other } = await setup();
    ctx.dns.set(OTHER, NO_SPF);
    await runDailyDnsCheck(ctx);
    await ctx.db
      .update(mailboxes)
      .set({ status: "disconnected" })
      .where(eq(mailboxes.id, other.id));
    const result = await runDailyDnsCheck(ctx);
    expect(result.domains.map((row) => row.domain)).toEqual([DOMAIN]);
    expect(result.resolved_without_mailboxes).toBe(1);
    const [problem] = await dnsProblems(ctx);
    expect(problem?.status).toBe("resolved");
  });

  it("skips workspaces with the setting off and sandbox workspaces", async () => {
    const off = await setup({ sending: { daily_dns_check: false } });
    off.ctx.dns.set(DOMAIN, NO_SPF);
    expect(await runDailyDnsCheck(off.ctx)).toMatchObject({ skipped: "setting_off", domains: [] });
    expect(off.ctx.dns.lookups).toHaveLength(0);
    expect(await dnsProblems(off.ctx)).toHaveLength(0);

    const sandbox = await setup({}, { sandbox: true });
    expect(await runDailyDnsCheck(sandbox.ctx)).toMatchObject({ skipped: "sandbox" });
    expect(sandbox.ctx.dns.lookups).toHaveLength(0);
  });
});
