/**
 * workspaces.readiness says what the engine enforces (docs/getting-started/going-live.md): every
 * blocker it can list is something the engine refuses (the launch) or holds (the send), and a
 * warning never stops a real send. Mail goes to a local SMTP server on 127.0.0.1, so "handed
 * over" means the server took the message; LinkedIn calls go to a recording fetch.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig } from "../../src/core/config.js";
import {
  campaigns,
  type Mailbox,
  messages,
  type NewMailbox,
  type Person,
  problems,
} from "../../src/db/schema/index.js";
import { storePasswords } from "../../src/modules/email/credentials.js";
import { getSandboxOutbox } from "../../src/modules/email/sandbox-transport.js";
import { ingestInboundEmail } from "../../src/modules/email/service.js";
import {
  READINESS_BLOCKER_IDS,
  type SendingReadiness,
} from "../../src/modules/workspaces/readiness.js";
import {
  createTestEngine,
  type TestCallOptions,
  type TestEngine,
} from "../../src/testing/engine.js";
import {
  seedCompany,
  seedLinkedInAccount,
  seedMailbox,
  seedPerson,
} from "../../src/testing/factories.js";
import { resetFakeImap } from "../../src/testing/fake-imap.js";
import { MAIL_PASSWORD, type MailServer, startMailServer } from "./acceptance/mail-server.js";
import { type Any, MINUTE, settle, TUESDAY_MORNING, until } from "./acceptance/support.js";

vi.mock("imapflow", async () => (await import("../../src/testing/fake-imap.js")).fakeImapModule());

const PUBLIC_BASE_URL = "https://outbound.example.com";
const POSTAL_ADDRESS = "1 Example Way, Austin, TX 78701, USA";
/** Unipile from the engine's .env (invented values: the recording fetch answers every call). */
const UNIPILE_ENV = { UNIPILE_DSN: "api1.unipile.example.com:13111", UNIPILE_API_KEY: "test-key" };

let server: MailServer;
const engines: TestEngine[] = [];

beforeAll(async () => {
  server = await startMailServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  resetFakeImap();
  server.received.length = 0;
});
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
});

interface Engine {
  engine: TestEngine;
  /** URLs of every provider call (LinkedIn), in order. */
  providerCalls: string[];
}

async function startEngine(
  options: { baseUrl?: string; env?: Record<string, string> } = {},
): Promise<Engine> {
  const providerCalls: string[] = [];
  const engine = await createTestEngine({
    now: TUESDAY_MORNING,
    config: {
      baseUrl: options.baseUrl ?? PUBLIC_BASE_URL,
      ...(options.env ? { env: options.env } : {}),
    } as Partial<EngineConfig>,
    providerFetch: async (input) => {
      providerCalls.push(String(input));
      return new Response(JSON.stringify({ title: "Unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  engines.push(engine);
  return { engine, providerCalls };
}

interface Client {
  engine: TestEngine;
  id: string;
  slug: string;
  target: { db: TestEngine["db"]; workspace: { id: string } };
  call<T = Any>(operationId: string, input?: unknown, options?: TestCallOptions): Promise<T>;
  readiness(): Promise<SendingReadiness>;
}

/** A client workspace with a company profile and a postal address (unless given otherwise). */
async function client(
  engine: TestEngine,
  slug: string,
  options: { settings?: Record<string, unknown>; sandbox?: boolean } = {},
): Promise<Client> {
  const created = (await engine.call("workspaces.create", {
    name: `Client ${slug}`,
    slug,
    timezone: "America/Chicago",
    ...(options.sandbox ? { is_sandbox: true } : {}),
    settings: options.settings ?? {
      company: {
        name: "Brightline Answering",
        website: "https://brightline-answering.example.org",
        postal_address: POSTAL_ADDRESS,
      },
    },
  })) as { id: string; slug: string };
  const call = <T = Any>(operationId: string, input: unknown = {}, options: TestCallOptions = {}) =>
    engine.call(operationId, input, { workspace: created.id, ...options }) as Promise<T>;
  return {
    engine,
    id: created.id,
    slug: created.slug,
    target: { db: engine.db, workspace: { id: created.id } },
    call,
    readiness: () => call<SendingReadiness>("workspaces.readiness"),
  };
}

/**
 * A real password mailbox on the local SMTP server, with IMAP (the in-memory fake): never tested,
 * DNS never checked, no warm-up ramp.
 */
async function smtpMailbox(
  owner: Client,
  email: string,
  overrides: Partial<NewMailbox> = {},
): Promise<Mailbox> {
  const ctx = await owner.engine.systemContext(owner.id);
  const secretId = await storePasswords(ctx, owner.id, email, MAIL_PASSWORD);
  return seedMailbox(owner.target, {
    email,
    from_name: "Alex Rivera",
    provider_label: "custom",
    auth_type: "password",
    secret_id: secretId,
    smtp: { host: "127.0.0.1", port: server.port, secure: false, user: email },
    imap: { host: "imap.brightline-answering.example.org", port: 993, secure: true, user: email },
    daily_limit: 40,
    ramp: null,
    min_gap_seconds: 60,
    max_gap_seconds: 120,
    ...overrides,
  });
}

/** A lead with an email address and a LinkedIn profile at an invented dental practice. */
async function lead(owner: Client, first: string, domain: string): Promise<Person> {
  const company = await seedCompany(owner.target, { name: `${first} Dental`, domain });
  return seedPerson(owner.target, {
    company_id: company.id,
    first_name: first,
    last_name: "Lindqvist",
    full_name: `${first} Lindqvist`,
    email: `${first.toLowerCase()}@${domain}`,
    linkedin_url: `https://www.linkedin.com/in/${first.toLowerCase()}-lindqvist-${domain.split(".")[0]}`,
  });
}

const EXACT_STEP = {
  type: "email",
  config: {
    style: "exact",
    subject: "front desk coverage",
    body: "Hi {{first_name}}, we answer overflow calls for dental groups so patients never hit voicemail. Would that help your front desk?",
  },
};
const AI_STEP = {
  type: "email",
  config: { style: "free", instruction: "Lead with their front desk." },
};

/** A draft campaign on the given senders (exact text unless other steps are given). */
function campaign(
  owner: Client,
  senders: { mailbox_ids?: string[]; linkedin_account_ids?: string[] },
  steps: Array<Record<string, unknown>> = [EXACT_STEP],
) {
  return owner.call<{ id: string }>("campaigns.create", {
    name: "Front desk coverage",
    steps,
    settings: {
      review_level: "unsure",
      senders,
      writing: { instructions: "Offer overflow call answering for dental groups." },
    },
  });
}

/** A real client with an SMTP mailbox, a lead and a campaign with the lead enrolled (a draft). */
async function emailClient(
  engine: TestEngine,
  slug: string,
  options: { sandbox?: boolean; steps?: Array<Record<string, unknown>> } = {},
) {
  const owner = await client(engine, slug, options.sandbox ? { sandbox: true } : {});
  const mailbox = await smtpMailbox(owner, `alex@${slug}-answering.example.org`);
  const person = await lead(owner, "Tomas", `${slug}-dental.example.com`);
  const created = await campaign(owner, { mailbox_ids: [mailbox.id] }, options.steps);
  await owner.call("campaigns.enroll", { campaign_id: created.id, person_ids: [person.id] });
  return { owner, mailbox, person, campaignId: created.id, address: person.email ?? "" };
}

/** What the local mail server took for one recipient. */
const handedTo = (address: string) =>
  server.received.filter((received) => received.to.includes(address));

async function outbound(owner: Client, personId: string) {
  return owner.engine.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, owner.id),
        eq(messages.person_id, personId),
        eq(messages.direction, "outbound"),
      ),
    );
}

/** Runs the worker through `minutes` of engine time, five minutes at a time. */
async function runFor(engine: TestEngine, minutes: number): Promise<void> {
  await settle(engine);
  for (let elapsed = 0; elapsed < minutes; elapsed += 5) {
    engine.advance(5 * MINUTE);
    await settle(engine);
  }
}

const ids = (items: Array<{ id: string }>) => items.map((entry) => entry.id);

/** The blocker ids of a channel. */
async function blockers(owner: Client, channel: "email" | "linkedin"): Promise<string[]> {
  return ids((await owner.readiness())[channel].blockers);
}

/** The launch is refused with this checklist item failing, and the campaign stays a draft. */
async function launchRefused(owner: Client, campaignId: string, key: string): Promise<void> {
  const preview = await owner.call(
    "campaigns.launch",
    { campaign_id: campaignId },
    { dryRun: true },
  );
  expect(preview.preview.ready).toBe(false);
  expect(preview.preview.items).toContainEqual(expect.objectContaining({ key, status: "fail" }));
  await expect(owner.call("campaigns.launch", { campaign_id: campaignId })).rejects.toMatchObject({
    code: "validation_failed",
  });
  const [row] = await owner.engine.db
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  expect(row?.status).toBe("draft");
}

/** Nothing for this person was sent or failed, and the mail server got nothing for them. */
async function held(owner: Client, person: Person): Promise<void> {
  expect(handedTo(person.email ?? "")).toEqual([]);
  for (const row of await outbound(owner, person.id)) {
    expect(["sent", "failed", "bounced", "unknown"]).not.toContain(row.status);
  }
}

/** A LinkedIn account through Unipile (active unless said otherwise). */
function unipileAccount(owner: Client, status: "active" | "paused" = "active") {
  return seedLinkedInAccount(owner.target, {
    provider: "unipile",
    status,
    name: "Alex Rivera",
    external_account_id: `acct_${owner.slug}`,
  });
}

/** The provider_down problem that pauses Unipile for the workspace (its key was rejected). */
async function pauseUnipile(owner: Client): Promise<void> {
  const now = owner.engine.clock.now();
  await owner.engine.db.insert(problems).values({
    workspace_id: owner.id,
    kind: "provider_down",
    severity: "high",
    owner: "person",
    title: "Unipile is paused: its credentials were rejected",
    reason: "Unipile answered 401.",
    remedy:
      "Check the Unipile key with manage_providers action set, then manage_providers action test.",
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
}

interface Proof {
  /** What the engine does, in the test title. */
  does: string;
  run(): Promise<void>;
}

/**
 * One proof per blocker id: the setup that makes readiness list it, then what the engine does
 * about it. A blocker added to readiness without a proof here fails the coverage test below.
 */
const PROOFS: Record<(typeof READINESS_BLOCKER_IDS)[number], Proof> = {
  sandbox: {
    does: "sends to the simulator, never to the mail server",
    async run() {
      const { engine } = await startEngine();
      const { owner, person, campaignId } = await emailClient(engine, "practice", {
        sandbox: true,
      });
      expect(await blockers(owner, "email")).toEqual(["sandbox"]);
      expect(await blockers(owner, "linkedin")).toEqual(["sandbox"]);
      await owner.call("campaigns.launch", { campaign_id: campaignId });
      await until(engine, "the email goes to the simulator", async () => {
        return (await outbound(owner, person.id)).some((row) => row.status === "sent");
      });
      expect(getSandboxOutbox({ workspaceId: owner.id }).length).toBeGreaterThan(0);
      expect(handedTo(person.email ?? "")).toEqual([]);
    },
  },
  paused: {
    does: "holds every send until the workspace resumes",
    async run() {
      const { engine } = await startEngine();
      const { owner, person, campaignId } = await emailClient(engine, "paused");
      await owner.call("campaigns.launch", { campaign_id: campaignId });
      await owner.call("workspaces.pause", {});
      expect((await blockers(owner, "email"))[0]).toBe("paused");
      expect((await blockers(owner, "linkedin"))[0]).toBe("paused");
      await runFor(engine, 90);
      await held(owner, person);
      await owner.call("workspaces.resume", {});
      await until(engine, "the email goes out after the resume", async () => {
        return handedTo(person.email ?? "").length > 0;
      });
    },
  },
  archived: {
    does: "holds every send while the workspace is archived",
    async run() {
      const { engine } = await startEngine();
      const { owner, person, campaignId } = await emailClient(engine, "archived");
      await owner.call("campaigns.launch", { campaign_id: campaignId });
      await owner.call("workspaces.update", { archived: true });
      expect((await blockers(owner, "email"))[0]).toBe("archived");
      expect((await blockers(owner, "linkedin"))[0]).toBe("archived");
      await runFor(engine, 90);
      await held(owner, person);
      await owner.call("workspaces.update", { archived: false });
      await until(engine, "the email goes out once restored", async () => {
        return handedTo(person.email ?? "").length > 0;
      });
    },
  },
  no_mailbox: {
    does: "refuses to launch a campaign with email steps",
    async run() {
      const { engine } = await startEngine();
      const owner = await client(engine, "no-mailbox");
      const created = await campaign(owner, { mailbox_ids: [] });
      expect(await blockers(owner, "email")).toContain("no_mailbox");
      await launchRefused(owner, created.id, "mailboxes");
    },
  },
  mailbox_not_sending: {
    does: "refuses to launch from a mailbox that cannot send",
    async run() {
      const { engine } = await startEngine();
      const owner = await client(engine, "mailbox-error");
      const mailbox = await smtpMailbox(owner, "alex@mailbox-error.example.org", {
        status: "error",
        status_reason: "Login refused",
      });
      const created = await campaign(owner, { mailbox_ids: [mailbox.id] });
      expect(await blockers(owner, "email")).toContain("mailbox_not_sending");
      await launchRefused(owner, created.id, "mailboxes");
    },
  },
  reply_sync: {
    does: "refuses to launch from a mailbox without IMAP",
    async run() {
      const { engine } = await startEngine();
      const owner = await client(engine, "no-imap");
      const mailbox = await smtpMailbox(owner, "alex@no-imap.example.org", { imap: null });
      const created = await campaign(owner, { mailbox_ids: [mailbox.id] });
      expect(await blockers(owner, "email")).toContain("reply_sync");
      await launchRefused(owner, created.id, "reply_sync");
    },
  },
  base_url: {
    does: "refuses to launch campaign email without a public https base URL",
    async run() {
      const { engine } = await startEngine({ baseUrl: "http://localhost:7331" });
      const owner = await client(engine, "local-url");
      const mailbox = await smtpMailbox(owner, "alex@local-url.example.org");
      const created = await campaign(owner, { mailbox_ids: [mailbox.id] });
      expect(await blockers(owner, "email")).toContain("base_url");
      await launchRefused(owner, created.id, "unsubscribe_link");
    },
  },
  postal_address: {
    does: "refuses to launch campaign email without a postal address",
    async run() {
      const { engine } = await startEngine();
      const owner = await client(engine, "no-address", {
        settings: { company: { name: "Brightline Answering" } },
      });
      const mailbox = await smtpMailbox(owner, "alex@no-address.example.org");
      const created = await campaign(owner, { mailbox_ids: [mailbox.id] });
      expect(await blockers(owner, "email")).toContain("postal_address");
      await launchRefused(owner, created.id, "postal_address");
    },
  },
  linkedin_provider: {
    does: "refuses to connect a LinkedIn account, so LinkedIn steps cannot launch",
    async run() {
      // No UNIPILE_DSN and UNIPILE_API_KEY in the engine's .env, no provider setting.
      const { engine, providerCalls } = await startEngine();
      const owner = await client(engine, "no-provider");
      const created = await campaign(owner, { linkedin_account_ids: [] }, [
        { type: "linkedin_visit", config: {} },
      ]);
      expect((await blockers(owner, "linkedin"))[0]).toBe("linkedin_provider");
      await expect(
        owner.call("linkedin.accounts.connect", { accept_risk: true }),
      ).rejects.toMatchObject({ code: "provider_not_configured" });
      await launchRefused(owner, created.id, "linkedin_accounts");
      expect(providerCalls).toEqual([]);

      // Stored for the workspace (what `providers set --workspace` does): the blocker is gone.
      await owner.call("providers.set", {
        slot: "linkedin",
        provider: "unipile",
        secrets: { dsn: "api1.unipile.example.com:13111", api_key: "test-key" },
      });
      expect(await blockers(owner, "linkedin")).not.toContain("linkedin_provider");
    },
  },
  no_linkedin_account: {
    does: "refuses to launch LinkedIn steps without an account",
    async run() {
      const { engine } = await startEngine({ env: UNIPILE_ENV });
      const owner = await client(engine, "no-account");
      const created = await campaign(owner, { linkedin_account_ids: [] }, [
        { type: "linkedin_visit", config: {} },
      ]);
      expect(await blockers(owner, "linkedin")).toContain("no_linkedin_account");
      await launchRefused(owner, created.id, "linkedin_accounts");
    },
  },
  linkedin_not_active: {
    does: "refuses to launch LinkedIn steps from an account that is not active",
    async run() {
      const { engine } = await startEngine({ env: UNIPILE_ENV });
      const owner = await client(engine, "paused-account");
      const account = await unipileAccount(owner, "paused");
      const created = await campaign(owner, { linkedin_account_ids: [account.id] }, [
        { type: "linkedin_visit", config: {} },
      ]);
      expect(await blockers(owner, "linkedin")).toContain("linkedin_not_active");
      await launchRefused(owner, created.id, "linkedin_accounts");
    },
  },
  linkedin_paused: {
    does: "makes no LinkedIn call while the provider is paused",
    async run() {
      const { engine, providerCalls } = await startEngine({ env: UNIPILE_ENV });
      const owner = await client(engine, "paused-provider");
      const account = await unipileAccount(owner);
      const person = await lead(owner, "Ines", "paused-provider-dental.example.com");
      const created = await campaign(owner, { linkedin_account_ids: [account.id] }, [
        { type: "linkedin_visit", config: {} },
      ]);
      await owner.call("campaigns.enroll", { campaign_id: created.id, person_ids: [person.id] });
      await pauseUnipile(owner);
      expect(await blockers(owner, "linkedin")).toContain("linkedin_paused");
      await owner.call("campaigns.launch", { campaign_id: created.id });
      await runFor(engine, 90);
      expect(providerCalls).toEqual([]);
      await held(owner, person);
      // The visit came due and waits for a later slot, with the pause as the reason; the
      // account stays active (the pause is the provider's, not the account's).
      const [visit] = await outbound(owner, person.id);
      expect(visit).toMatchObject({ action: "visit", status: "scheduled" });
      expect(visit?.error).toContain("is paused for this workspace");
      const accounts = (await owner.call("linkedin.accounts.list", {})) as {
        items: Array<{ id: string; status: string }>;
      };
      expect(accounts.items.find((row) => row.id === account.id)?.status).toBe("active");
    },
  },
  brain: {
    does: "never sends an AI-written step without a brain, and fails nothing",
    async run() {
      const { engine } = await startEngine();
      const { owner, person, campaignId } = await emailClient(engine, "no-brain", {
        steps: [AI_STEP],
      });
      await owner.call("campaigns.launch", { campaign_id: campaignId });
      expect(await blockers(owner, "email")).toEqual(["brain"]);
      await runFor(engine, 90);
      await held(owner, person);
    },
  },
  nothing_to_send: {
    does: "sends nothing until a campaign is launched",
    async run() {
      const { engine } = await startEngine();
      const { owner, person } = await emailClient(engine, "nothing");
      // A missing brain blocks too while nothing waits (see the brain proof).
      expect(await blockers(owner, "email")).toEqual(["brain", "nothing_to_send"]);
      await runFor(engine, 90);
      await held(owner, person);
      expect(await outbound(owner, person.id)).toEqual([]);
    },
  },
};

describe("readiness and the engine agree", () => {
  it("sends a real email when only warnings remain", async () => {
    const { engine } = await startEngine();
    const harbor = await client(engine, "harbor");
    // Never tested, DNS never checked: both are warnings, not blockers.
    const mailbox = await smtpMailbox(harbor, "alex@brightline-answering.example.org");
    const tomas = await lead(harbor, "Tomas", "fjord-dental.example.com");
    const created = await campaign(harbor, { mailbox_ids: [mailbox.id] });
    await harbor.call("campaigns.enroll", { campaign_id: created.id, person_ids: [tomas.id] });
    await harbor.call("campaigns.launch", { campaign_id: created.id });

    const before = await harbor.readiness();
    expect(before.email.ready).toBe(true);
    expect(ids(before.email.blockers)).toEqual([]);
    expect(ids(before.email.warnings)).toEqual(
      expect.arrayContaining(["mailbox_not_tested", "dns"]),
    );
    expect(before.summary).toMatch(/^Email can reach real people\./);
    expect(handedTo("tomas@fjord-dental.example.com")).toHaveLength(0);

    await until(engine, "the first email reaches the mail server", async () => {
      return handedTo("tomas@fjord-dental.example.com").length > 0;
    });
    expect(handedTo("tomas@fjord-dental.example.com")).toHaveLength(1);
    const [sent] = await outbound(harbor, tomas.id);
    expect(sent).toMatchObject({ status: "sent", mailbox_id: mailbox.id });
  });

  it("sends a reply a person approves while the base URL stops campaign email", async () => {
    const { engine } = await startEngine({ baseUrl: "http://localhost:7331" });
    const owner = await client(engine, "harbor");
    const mailbox = await smtpMailbox(owner, "alex@brightline-answering.example.org");
    const dana = await lead(owner, "Dana", "client-dental.example.com");
    const inbound = await ingestInboundEmail(await engine.systemContext(owner.id), {
      mailboxId: mailbox.id,
      from: dana.email ?? "",
      to: [mailbox.email],
      subject: "Overflow calls",
      text: "Do you also cover Saturday mornings?",
      headers: {},
      messageIdHeader: "<question-1@client-dental.example.com>",
      receivedAt: engine.clock.now(),
    });
    if (!inbound.threadId) throw new Error("the email did not open a thread");

    const readiness = await owner.readiness();
    expect(readiness.email.ready).toBe(false);
    expect(ids(readiness.email.blockers)).toContain("base_url");
    expect(readiness.email.replies_ready).toBe(true);
    expect(readiness.summary).not.toMatch(/^Nothing can reach a real person/);
    expect(readiness.summary).toContain("Replies you approve still go out by email.");

    // A person answers: the reply is handed to the mail server.
    await owner.call("threads.send_reply", {
      thread_id: inbound.threadId,
      text: "Hi Dana, yes, Saturday mornings are covered too.",
    });
    await until(engine, "the reply reaches the mail server", async () => {
      return handedTo(dana.email ?? "").length > 0;
    });
    expect(handedTo(dana.email ?? "")).toHaveLength(1);
  });
});

describe("every readiness blocker is enforced", () => {
  it("has a proof for each blocker id", () => {
    expect(Object.keys(PROOFS).sort()).toEqual([...READINESS_BLOCKER_IDS].sort());
  });

  for (const [id, proof] of Object.entries(PROOFS)) {
    it(`${id}: the engine ${proof.does}`, { timeout: 60_000 }, () => proof.run());
  }
});
