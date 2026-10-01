import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineConfig } from "../../core/config.js";
import {
  linkedin_accounts,
  mailboxes,
  messages,
  type NewMailbox,
  problems,
  workspaces,
} from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import {
  seedCampaign,
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
} from "../../testing/factories.js";
import { module as system } from "../system/index.js";
import { module as workspacesModule } from "./index.js";
import type { SendingReadiness } from "./readiness.js";

const TUESDAY = "2026-09-22T15:00:00.000Z";
const PUBLIC = { baseUrl: "https://outbound.example.com" };
const BRAIN = { env: { ANTHROPIC_API_KEY: "sk-ant-test" } };
/** Unipile from the engine's .env (invented values). */
const UNIPILE = { UNIPILE_DSN: "api1.unipile.example.com:13111", UNIPILE_API_KEY: "test-key" };
const BRAIN_AND_LINKEDIN = { env: { ...BRAIN.env, ...UNIPILE } };
const IMAP = { host: "imap.example.com", port: 993, secure: true, user: "sam@brand.example.com" };

let engine: TestEngine;
afterEach(async () => {
  await engine?.close();
});

async function start(config: Partial<EngineConfig> = {}): Promise<TestEngine> {
  engine = await createTestEngine({
    modules: [workspacesModule, system],
    now: TUESDAY,
    config: config as EngineConfig,
  });
  return engine;
}

async function createWorkspace(input: Record<string, unknown>) {
  const created = (await engine.call("workspaces.create", input)) as { id: string; slug: string };
  return { ...created, target: { db: engine.db, workspace: { id: created.id } } };
}

const readiness = (workspace: string) =>
  engine.call("workspaces.readiness", {}, { workspace }) as Promise<SendingReadiness>;
const ids = (items: Array<{ id: string }>) => items.map((entry) => entry.id);

/** A real mailbox with IMAP that passed its login test. */
function testedMailbox(overrides: Partial<NewMailbox> = {}): Partial<NewMailbox> {
  return {
    email: "sam@brand.example.com",
    provider_label: "custom" as const,
    auth_type: "password" as const,
    smtp: { host: "smtp.example.com", port: 465, secure: true, user: "sam@brand.example.com" },
    imap: IMAP,
    created_at: new Date("2026-06-01T00:00:00.000Z"),
    health: { last_test: { at: "2026-09-21T10:00:00.000Z", smtp: "ok", imap: "ok" } },
    dns: {
      checked_at: "2026-09-21T10:00:00.000Z",
      mx: true,
      spf: true,
      dkim: true,
      dmarc: true,
      issues: [],
    },
    ...overrides,
  };
}

describe("workspaces.readiness", () => {
  it("never calls a sandbox workspace ready: nothing in it reaches a real person", async () => {
    await start(PUBLIC);
    await createWorkspace({ name: "Practice", slug: "practice", is_sandbox: true });
    const result = await readiness("practice");
    expect(result.sandbox).toBe(true);
    expect(result.email.ready).toBe(false);
    expect(result.linkedin.ready).toBe(false);
    expect(ids(result.email.blockers)).toEqual(["sandbox"]);
    expect(ids(result.linkedin.blockers)).toEqual(["sandbox"]);
    expect(result.summary).toContain("nothing it does ever reaches a real person");
    expect(result.email.blockers[0]?.fix).toContain("openoutbound workspaces create");
  });

  it("lists every blocker of a fresh real workspace with the exact fix", async () => {
    await start();
    await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    const result = await readiness("harbor");
    expect(result.sandbox).toBe(false);
    expect(result.email.ready).toBe(false);
    expect(ids(result.email.blockers)).toEqual([
      "no_mailbox",
      "base_url",
      "postal_address",
      "brain",
      "nothing_to_send",
    ]);
    expect(ids(result.linkedin.blockers)).toEqual([
      "linkedin_provider",
      "no_linkedin_account",
      "brain",
      "nothing_to_send",
    ]);
    const byId = Object.fromEntries(result.email.blockers.map((entry) => [entry.id, entry]));
    expect(byId.base_url?.detail).toContain("http://localhost:7331");
    expect(byId.base_url?.fix).toContain("OPENOUTBOUND_BASE_URL");
    expect(byId.no_mailbox?.fix).toContain("openoutbound mailboxes add --workspace harbor");
    // The password variable is read by the engine, not by the shell that runs the CLI.
    expect(byId.no_mailbox?.fix).toContain(
      "Put MAILBOX_<NAME>_PASSWORD=<app password> in the engine's .env first and restart `openoutbound serve`",
    );
    expect(byId.postal_address?.fix).toContain(
      `openoutbound workspaces update --workspace harbor --settings '{"company":{"postal_address":"<postal address>"}}'`,
    );
    // Windows PowerShell 5.1 strips the quotes inside JSON flags: the fix says the file way.
    expect(byId.postal_address?.fix).toContain(
      "In Windows PowerShell 5.1, write that JSON to settings.json and pass --settings '@settings.json' instead.",
    );
    expect(byId.nothing_to_send?.fix).toContain(
      "openoutbound campaigns launch --workspace harbor --campaign-id <campaign id>",
    );
    expect(result.summary).toMatch(/^Nothing can reach a real person yet\. Email: No real mailbox/);
    // Nothing can send a reply either.
    expect(result.email.replies_ready).toBe(false);
    expect(result.email.replies).toContain("No real mailbox is connected");
    expect(result.linkedin.replies_ready).toBe(false);
  });

  it("names the LinkedIn provider first while none is configured, with both ways to set it", async () => {
    await start(PUBLIC);
    await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    const result = await readiness("harbor");
    // Connecting an account needs the provider, so the provider comes first.
    expect(ids(result.linkedin.blockers).slice(0, 2)).toEqual([
      "linkedin_provider",
      "no_linkedin_account",
    ]);
    const provider = result.linkedin.blockers[0];
    expect(provider?.detail).toBe(
      "No LinkedIn provider is configured for this workspace, so no LinkedIn account can be connected and no LinkedIn action can go out.",
    );
    expect(provider?.fix).toContain(
      "Set UNIPILE_DSN and UNIPILE_API_KEY in the engine's .env and restart `openoutbound serve`",
    );
    expect(provider?.fix).toContain(
      `\`openoutbound providers set --workspace harbor --slot linkedin --provider unipile --secrets '{"dsn":"<host:port>","api_key":"<your key>"}'\``,
    );
    expect(provider?.fix).toContain("--secrets '@secrets.json'");
    expect(result.linkedin.replies_ready).toBe(false);
    expect(result.linkedin.replies).toContain("No LinkedIn provider is configured");
    // The email channel does not need it.
    expect(ids(result.email.blockers)).not.toContain("linkedin_provider");
  });

  it("drops the LinkedIn provider blocker once Unipile is set in the engine's .env", async () => {
    await start({ ...PUBLIC, env: UNIPILE });
    await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    const result = await readiness("harbor");
    expect(ids(result.linkedin.blockers)[0]).toBe("no_linkedin_account");
    expect(ids(result.linkedin.blockers)).not.toContain("linkedin_provider");
  });

  it("says email is ready once a tested mailbox, the base URL, the address, a brain and a campaign are there", async () => {
    await start({ ...PUBLIC, ...BRAIN_AND_LINKEDIN });
    const ws = await createWorkspace({
      name: "Harbor Dental",
      slug: "harbor",
      settings: { company: { postal_address: "1 Example Street, Austin, TX 78701, US" } },
    });
    await seedMailbox(ws.target, testedMailbox());
    await seedCampaign(ws.target, { status: "active" });
    const result = await readiness("harbor");
    expect(result.email).toEqual({
      ready: true,
      replies_ready: true,
      replies:
        "Replies to people who wrote to you go out once a person approves them (mailboxes that can send: sam@brand.example.com).",
      blockers: [],
      warnings: [],
    });
    expect(result.linkedin.ready).toBe(false);
    expect(result.summary).toBe(
      "Email can reach real people. LinkedIn cannot: No LinkedIn account is connected, so LinkedIn steps cannot run.",
    );
  });

  it("says replies still go out while the base URL and the postal address stop campaign email", async () => {
    // The base URL and the postal address are checked for campaign email only: an approved reply
    // to someone who wrote to you goes out (sending-checks.ts, the launch checklist).
    await start(BRAIN_AND_LINKEDIN);
    const ws = await createWorkspace({
      name: "Harbor Dental",
      slug: "harbor",
      settings: { replies: { question: { action: "auto_reply" } } },
    });
    await seedMailbox(ws.target, testedMailbox());
    const person = await seedPerson(ws.target);
    await seedMessage(ws.target, {
      person_id: person.id,
      channel: "email",
      action: "reply",
      direction: "outbound",
      status: "approved",
    });
    const result = await readiness("harbor");
    expect(result.email.ready).toBe(false);
    expect(ids(result.email.blockers)).toEqual(["base_url", "postal_address"]);
    expect(result.email.blockers[1]?.detail).toContain(
      "Replies to people who wrote to you still go out.",
    );
    expect(result.email.replies_ready).toBe(true);
    expect(result.email.replies).toBe(
      "Replies to people who wrote to you go out once a person approves them (mailboxes that can send: sam@brand.example.com), and automatic replies go out on their own (auto_reply is on).",
    );
    expect(result.summary).not.toMatch(/^Nothing can reach a real person/);
    expect(result.summary).toMatch(
      /^No campaign message can reach a real person yet\. Email: OPENOUTBOUND_BASE_URL is http:\/\/localhost:7331, /,
    );
    expect(result.summary).toMatch(/ Replies you approve still go out by email\.$/);

    // LinkedIn ready while campaign email is not: the summary names campaign email only.
    await seedLinkedInAccount(ws.target, { provider: "unipile", status: "active" });
    await seedCampaign(ws.target, {
      status: "active",
      steps: [{ type: "linkedin_invite", config: { note: "none" } }],
    });
    const later = await readiness("harbor");
    expect(later.linkedin.ready).toBe(true);
    expect(later.summary).toMatch(
      /^LinkedIn can reach real people\. Campaign email cannot: OPENOUTBOUND_BASE_URL is /,
    );
    expect(later.summary).toMatch(/ Replies you approve still go out by email\.$/);
  });

  it("stops replies too while the workspace is paused, a sandbox or has no mailbox that can send", async () => {
    await start({ ...PUBLIC, ...BRAIN });
    const ws = await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    const mailbox = await seedMailbox(ws.target, testedMailbox({ status: "paused", health: {} }));
    let result = await readiness("harbor");
    expect(result.email.replies_ready).toBe(false);
    expect(result.email.replies).toBe(
      "Replies cannot go out either: No mailbox can send: sam@brand.example.com is paused.",
    );
    await engine.db.update(mailboxes).set({ status: "active" }).where(eq(mailboxes.id, mailbox.id));
    expect((await readiness("harbor")).email.replies_ready).toBe(true);
    await engine.db.update(workspaces).set({ status: "paused" }).where(eq(workspaces.id, ws.id));
    result = await readiness("harbor");
    expect(result.email.replies_ready).toBe(false);
    expect(result.email.replies).toContain("Sending is paused for this workspace");
    expect(result.summary).toMatch(/^Nothing can reach a real person yet\./);

    await createWorkspace({ name: "Practice", slug: "practice", is_sandbox: true });
    const sandbox = await readiness("practice");
    expect(sandbox.email.replies_ready).toBe(false);
    expect(sandbox.email.replies).toBe(
      "Sandbox workspace: replies go to the simulator, never to a real person.",
    );
  });

  it("blocks on a missing brain only while nothing waiting can go out without AI", async () => {
    await start(PUBLIC);
    const ws = await createWorkspace({
      name: "Harbor Dental",
      slug: "harbor",
      settings: { company: { postal_address: "1 Example Street" } },
    });
    await seedMailbox(ws.target, testedMailbox());
    await seedCampaign(ws.target, { status: "active" });
    let result = await readiness("harbor");
    expect(ids(result.email.blockers)).toEqual(["brain"]);
    // An exact-text step goes out without a brain (the AI-written steps wait): a warning.
    await seedCampaign(ws.target, {
      status: "active",
      steps: [{ type: "email", config: { style: "exact", subject: "Hello", body: "Hi there." } }],
    });
    result = await readiness("harbor");
    expect(result.email.ready).toBe(true);
    expect(ids(result.email.blockers)).toEqual([]);
    expect(ids(result.email.warnings)).toEqual(["brain"]);
  });

  it("keeps active campaigns sending without a postal address or IMAP, and warns about it", async () => {
    // Both are checked when a campaign launches; one already running keeps sending.
    await start({ ...PUBLIC, ...BRAIN });
    const ws = await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    await seedMailbox(ws.target, testedMailbox({ imap: null }));
    let result = await readiness("harbor");
    expect(ids(result.email.blockers)).toEqual(["reply_sync", "postal_address", "nothing_to_send"]);

    await seedCampaign(ws.target, { status: "active" });
    result = await readiness("harbor");
    expect(result.email.ready).toBe(true);
    expect(ids(result.email.blockers)).toEqual([]);
    expect(ids(result.email.warnings)).toEqual(["reply_sync", "postal_address"]);
    expect(result.email.warnings[0]?.detail).toContain(
      "while active campaigns keep sending from sam@brand.example.com",
    );
    expect(result.email.warnings[1]?.detail).toContain(
      "active campaigns send their emails without one",
    );
  });

  it("needs a mailbox that sends and reads replies, and warns until it passed its test", async () => {
    await start({ ...PUBLIC, ...BRAIN });
    const ws = await createWorkspace({
      name: "Harbor Dental",
      slug: "harbor",
      settings: { company: { postal_address: "1 Example Street" } },
    });
    // Something to send that is not a campaign: a running campaign would turn the missing IMAP
    // (checked at launch only) into a warning.
    const person = await seedPerson(ws.target);
    await seedMessage(ws.target, {
      person_id: person.id,
      action: "reply",
      direction: "outbound",
      status: "approved",
    });
    const mailbox = await seedMailbox(
      ws.target,
      testedMailbox({ status: "error", status_reason: "Login refused", health: {} }),
    );
    let result = await readiness("harbor");
    expect(ids(result.email.blockers)).toEqual(["mailbox_not_sending"]);
    expect(result.email.blockers[0]?.detail).toContain(
      "sam@brand.example.com is error (Login refused)",
    );
    expect(result.email.blockers[0]?.fix).toContain(
      `openoutbound mailboxes test --workspace harbor --mailbox-id ${mailbox.id}`,
    );

    await engine.db
      .update(mailboxes)
      .set({ status: "active", imap: null })
      .where(eq(mailboxes.id, mailbox.id));
    result = await readiness("harbor");
    expect(ids(result.email.blockers)).toEqual(["reply_sync"]);
    expect(result.email.blockers[0]?.fix).toContain("--imap-host <imap server>");

    // The engine sends from a mailbox that was never tested, so that is a warning, not a blocker.
    await engine.db.update(mailboxes).set({ imap: IMAP }).where(eq(mailboxes.id, mailbox.id));
    result = await readiness("harbor");
    expect(result.email.ready).toBe(true);
    expect(ids(result.email.blockers)).toEqual([]);
    expect(ids(result.email.warnings)).toEqual(["mailbox_not_tested"]);
    expect(result.email.warnings[0]?.detail).toContain(
      "sam@brand.example.com: sending (SMTP) not tested, reading replies (IMAP) not tested",
    );
    expect(result.email.warnings[0]?.detail).toContain(
      "The engine still sends from a mailbox that was not tested",
    );
    expect(result.summary).toMatch(/^Email can reach real people\./);

    // A clean IMAP sync counts for reading; a failed SMTP test does not count for sending.
    await engine.db
      .update(mailboxes)
      .set({
        last_synced_at: new Date(TUESDAY),
        health: { last_test: { at: TUESDAY, smtp: "failed", imap: "skipped" } },
      })
      .where(eq(mailboxes.id, mailbox.id));
    result = await readiness("harbor");
    expect(result.email.warnings[0]?.detail).toContain(
      "yet: sam@brand.example.com: sending (SMTP) failed its test.",
    );

    await engine.db
      .update(mailboxes)
      .set({ health: { last_test: { at: TUESDAY, smtp: "ok", imap: "ok" } } })
      .where(eq(mailboxes.id, mailbox.id));
    result = await readiness("harbor");
    expect(result.email.ready).toBe(true);
    expect(ids(result.email.warnings)).toEqual([]);
  });

  it("does not count sandbox mailboxes and accounts in a real workspace", async () => {
    await start({ ...PUBLIC, ...BRAIN_AND_LINKEDIN });
    const ws = await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    await seedMailbox(ws.target);
    await seedLinkedInAccount(ws.target);
    const result = await readiness("harbor");
    expect(result.email.blockers[0]).toMatchObject({ id: "no_mailbox" });
    expect(result.email.blockers[0]?.detail).toContain("1 sandbox mailbox only send");
    expect(result.linkedin.blockers[0]).toMatchObject({ id: "no_linkedin_account" });
  });

  it("warns about warm-up and DNS without blocking", async () => {
    await start({ ...PUBLIC, ...BRAIN });
    const ws = await createWorkspace({
      name: "Harbor Dental",
      slug: "harbor",
      timezone: "America/Chicago",
      settings: { company: { postal_address: "1 Example Street" } },
    });
    await seedCampaign(ws.target, { status: "active" });
    const mailbox = await seedMailbox(
      ws.target,
      testedMailbox({
        created_at: new Date("2026-09-20T15:00:00.000Z"),
        ramp: { enabled: true, start: 5, increment: 5, every_days: 7, delay_days: 14 },
        dns: null,
      }),
    );
    const result = await readiness("harbor");
    expect(result.email.ready).toBe(true);
    expect(ids(result.email.warnings)).toEqual(["warmup", "dns"]);
    expect(result.email.warnings[0]?.detail).toContain("the first emails go out on 2026-10-04");
    expect(result.email.warnings[1]?.detail).toContain("not checked yet: brand.example.com");
    expect(result.email.warnings[1]?.fix).toContain(
      `openoutbound mailboxes check-dns --workspace harbor --mailbox-id ${mailbox.id}`,
    );

    await engine.db
      .update(mailboxes)
      .set({
        ramp: null,
        dns: {
          checked_at: TUESDAY,
          mx: true,
          spf: true,
          dkim: false,
          dmarc: true,
          issues: [],
          statuses: { mx: "green", spf: "green", dkim: "red", dmarc: "yellow" },
        },
      })
      .where(eq(mailboxes.id, mailbox.id));
    const later = await readiness("harbor");
    expect(ids(later.email.warnings)).toEqual(["dns"]);
    expect(later.email.warnings[0]?.detail).toContain(
      "brand.example.com: DKIM missing or broken, DMARC needs a look",
    );
  });

  it("puts a paused workspace first on both channels", async () => {
    await start({ ...PUBLIC, ...BRAIN });
    const ws = await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    await engine.db.update(workspaces).set({ status: "paused" }).where(eq(workspaces.id, ws.id));
    const result = await readiness("harbor");
    expect(result.email.blockers[0]).toMatchObject({
      id: "paused",
      fix: expect.stringContaining("openoutbound workspaces resume --workspace harbor"),
    });
    expect(result.linkedin.blockers[0]?.id).toBe("paused");
  });

  it("needs a launched campaign or an approved reply, and a brain unless nothing waiting needs one", async () => {
    await start(PUBLIC);
    const ws = await createWorkspace({
      name: "Harbor Dental",
      slug: "harbor",
      settings: { company: { postal_address: "1 Example Street" } },
    });
    await seedMailbox(ws.target, testedMailbox());
    let result = await readiness("harbor");
    expect(ids(result.email.blockers)).toEqual(["brain", "nothing_to_send"]);

    // An approved reply waits: it is written already, so a missing brain only warns.
    const person = await seedPerson(ws.target);
    await seedMessage(ws.target, {
      person_id: person.id,
      channel: "email",
      action: "reply",
      direction: "outbound",
      status: "approved",
    });
    result = await readiness("harbor");
    expect(ids(result.email.blockers)).toEqual([]);
    expect(ids(result.email.warnings)).toEqual(["brain"]);

    // An active campaign with an AI-written email step waits for the brain, but the reply still
    // goes out without one: still a warning.
    await seedCampaign(ws.target, { status: "active" });
    result = await readiness("harbor");
    expect(ids(result.email.blockers)).toEqual([]);
    expect(ids(result.email.warnings)).toEqual(["brain"]);
    expect(result.email.warnings[0]?.detail).toContain("wait until one is");
    expect(result.email.warnings[0]?.fix).toContain("ANTHROPIC_API_KEY");
    // The CLI form first, the MCP action after it, like every other fix.
    expect(result.email.warnings[0]?.fix).toContain(
      `\`openoutbound providers set --workspace harbor --slot brain --provider anthropic --secrets '{"api_key":"<your key>"}'\` (MCP: manage_providers action set, slot brain)`,
    );
    expect(result.email.warnings[0]?.fix).toContain("--secrets '@secrets.json'");
    expect(ids(result.linkedin.blockers)).toEqual([
      "linkedin_provider",
      "no_linkedin_account",
      "brain",
      "nothing_to_send",
    ]);

    // Once the reply went out, only AI-written steps wait: the brain blocks email.
    await engine.db
      .update(messages)
      .set({ status: "sent" })
      .where(eq(messages.workspace_id, ws.id));
    result = await readiness("harbor");
    expect(ids(result.email.blockers)).toEqual(["brain"]);
  });

  it("is ready for LinkedIn with an active account and a campaign with LinkedIn steps", async () => {
    await start({ ...PUBLIC, ...BRAIN_AND_LINKEDIN });
    const ws = await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    const account = await seedLinkedInAccount(ws.target, { provider: "unipile", status: "paused" });
    await seedCampaign(ws.target, {
      status: "active",
      steps: [{ type: "linkedin_invite", config: { note: "none" } }],
    });
    let result = await readiness("harbor");
    expect(ids(result.linkedin.blockers)).toEqual(["linkedin_not_active"]);
    expect(result.linkedin.blockers[0]?.fix).toContain(
      `openoutbound linkedin accounts resume --workspace harbor --account-id ${account.id}`,
    );
    await engine.db
      .update(linkedin_accounts)
      .set({ status: "active" })
      .where(eq(linkedin_accounts.id, account.id));
    result = await readiness("harbor");
    expect(result.linkedin).toEqual({
      ready: true,
      replies_ready: true,
      replies:
        "Replies to people who wrote to you on LinkedIn go out once a person approves them (active accounts: Sam Sender).",
      blockers: [],
      warnings: [],
    });
    expect(result.email.ready).toBe(false);
    expect(result.summary).toMatch(/^LinkedIn can reach real people\. Email cannot: /);
  });

  it("blocks LinkedIn while its provider is paused, and warns about a failing brain", async () => {
    await start({ ...PUBLIC, ...BRAIN_AND_LINKEDIN });
    const ws = await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    await seedLinkedInAccount(ws.target, { provider: "unipile", status: "active" });
    await seedCampaign(ws.target, {
      status: "active",
      steps: [{ type: "linkedin_invite", config: { note: "none" } }],
    });
    expect((await readiness("harbor")).linkedin.ready).toBe(true);

    const now = new Date(TUESDAY);
    await engine.db.insert(problems).values({
      workspace_id: ws.id,
      kind: "provider_down",
      severity: "high",
      owner: "person",
      title: "Unipile is paused: its credentials were rejected",
      reason: "Unipile answered 401.",
      remedy:
        "Check the Unipile key with manage_providers action set (slot linkedin), then manage_providers action test.",
      data: {
        slot: "linkedin",
        provider: "unipile",
        paused: true,
        failure: { class: "auth_invalid", retryable: false, scope: "account", provider: "unipile" },
      },
      dedupe_key: "provider_down:linkedin:unipile",
      created_at: now,
      updated_at: now,
    });
    let result = await readiness("harbor");
    expect(result.linkedin.ready).toBe(false);
    expect(ids(result.linkedin.blockers)).toEqual(["linkedin_paused"]);
    expect(result.linkedin.blockers[0]?.detail).toMatch(/^Unipile is paused/);
    expect(result.linkedin.blockers[0]?.fix).toContain("manage_providers action test");

    await engine.db.insert(problems).values({
      workspace_id: ws.id,
      kind: "brain_down",
      severity: "high",
      owner: "person",
      title: "The anthropic brain is not working",
      reason: "The key was rejected.",
      remedy: "Check the key with manage_providers action test (slot brain).",
      data: { provider: "anthropic", model: null, reason: "auth" },
      dedupe_key: "brain_down:anthropic",
      created_at: now,
      updated_at: now,
    });
    result = await readiness("harbor");
    expect(ids(result.linkedin.warnings)).toContain("brain_failing");
    expect(ids(result.linkedin.blockers)).toEqual(["linkedin_paused"]);
  });

  it("writes every fix as a command the CLI accepts", async () => {
    await start();
    const results: SendingReadiness[] = [];
    await createWorkspace({ name: "Practice", slug: "practice", is_sandbox: true });
    results.push(await readiness("practice"));
    const fresh = await createWorkspace({ name: "Harbor Dental", slug: "harbor" });
    results.push(await readiness("harbor"));
    await engine.db.update(workspaces).set({ status: "paused" }).where(eq(workspaces.id, fresh.id));
    results.push(await readiness("harbor"));
    await engine.db
      .update(workspaces)
      .set({ status: "archived" })
      .where(eq(workspaces.id, fresh.id));
    results.push(await readiness("harbor"));
    // One workspace per mailbox state: refused login, no IMAP, untested, warming without DNS.
    const states: Array<Partial<NewMailbox>> = [
      testedMailbox({ status: "error", health: {} }),
      testedMailbox({ imap: null }),
      testedMailbox({ health: {} }),
      testedMailbox({
        created_at: new Date("2026-09-20T15:00:00.000Z"),
        ramp: { enabled: true, start: 5, increment: 5, every_days: 7, delay_days: 14 },
        dns: null,
      }),
    ];
    for (const [index, state] of states.entries()) {
      const ws = await createWorkspace({ name: `Mailbox ${index}`, slug: `mailbox-${index}` });
      await seedMailbox(ws.target, state);
      await seedLinkedInAccount(ws.target, { provider: "unipile", status: "paused" });
      results.push(await readiness(`mailbox-${index}`));
    }

    const { createCommandChecker } = await import("../../testing/cli-commands.js");
    const check = createCommandChecker();
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const result of results) {
      for (const entry of [
        ...result.email.blockers,
        ...result.email.warnings,
        ...result.linkedin.blockers,
        ...result.linkedin.warnings,
      ]) {
        seen.add(entry.id);
        for (const span of entry.fix.matchAll(/`(openoutbound [^`]+)`/g)) {
          const error = check(span[1] as string);
          if (error) failures.push(`${entry.id}: ${span[1]}: ${error}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect([...seen].sort()).toEqual(
      [
        "archived",
        "base_url",
        "brain",
        "dns",
        "linkedin_not_active",
        "linkedin_provider",
        "mailbox_not_sending",
        "mailbox_not_tested",
        "no_linkedin_account",
        "no_mailbox",
        "nothing_to_send",
        "paused",
        "postal_address",
        "reply_sync",
        "sandbox",
        "warmup",
      ].sort(),
    );
  });

  it("states the review rules in plain words", async () => {
    await start(PUBLIC);
    const ws = await createWorkspace({
      name: "Harbor Dental",
      slug: "harbor",
      settings: {
        approvals: { default_review_level: "every", agent_launch_requires_approval: false },
        replies: { question: { action: "auto_reply" } },
      },
    });
    await seedCampaign(ws.target, {
      name: "Spring outreach",
      status: "active",
      settings: { review_level: "unsure" },
    });
    const { review } = await readiness("harbor");
    expect(review.level).toBe("every");
    expect(review.summary).toContain(
      "A person approves every campaign message before it goes out.",
    );
    expect(review.summary).toContain('"Spring outreach" (unsure)');
    expect(review.summary).toContain("Replies to question messages go out without review");
    expect(review.summary).toContain("Agents can launch campaigns without a person's approval.");
  });

  it("is the sending block of get_status, while ready keeps meaning setup is done", async () => {
    await start(PUBLIC);
    await createWorkspace({ name: "Practice", slug: "practice", is_sandbox: true });
    const status = (await engine.call("workspaces.status", {}, { workspace: "practice" })) as {
      ready: boolean;
      sending: SendingReadiness;
    };
    expect(status.sending).toEqual(await readiness("practice"));
    expect(status.sending.email.ready).toBe(false);
  });
});
