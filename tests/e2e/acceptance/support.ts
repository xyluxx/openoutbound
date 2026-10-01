/**
 * Shared set-up for the acceptance scenarios (spec section 10): the real engine on a cloned
 * in-memory database with a fixed clock, a fake brain that answers every engine prompt the
 * scenarios reach, and a client workspace with a sending mailbox (sandbox transport, so nothing
 * leaves the machine), an offer with a Calendly booking link and invented leads.
 *
 * Scenarios drive the engine the way production does: operations through the executor, jobs
 * and schedules run by the worker (`settle`, `until`), the inbound email path
 * (`ingestInboundEmail`, the single path behind IMAP sync) and HTTP webhooks. Rows are seeded
 * directly only for the world itself (people, companies, mailboxes), never for outcomes.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { expect } from "vitest";
import { createBrainService } from "../../../src/brain/service.js";
import type { BrainService, OpContext } from "../../../src/core/context.js";
import type { EventType } from "../../../src/core/events.js";
import type { WorkspaceSettingsInput } from "../../../src/core/settings.js";
import {
  type Company,
  companies,
  enrollments,
  events,
  type Mailbox,
  type Message,
  messages,
  type Person,
  people,
  problems,
  threads,
} from "../../../src/db/schema/index.js";
import type { WritingVars } from "../../../src/modules/campaigns/writing/prompts.js";
import { ingestInboundEmail } from "../../../src/modules/email/service.js";
import type { ClassifyOutput } from "../../../src/modules/inbox/prompts/classify.js";
import type { DraftVars } from "../../../src/modules/inbox/prompts/draft.js";
import type { BrainFactory } from "../../../src/runtime/brain.js";
import {
  createTestEngine,
  type TestCallOptions,
  type TestEngine,
} from "../../../src/testing/engine.js";
import {
  type SeedTarget,
  seedCompany,
  seedMailbox,
  seedPerson,
} from "../../../src/testing/factories.js";
import { createFakeBrain, type FakeBrain } from "../../../src/testing/fake-brain.js";

// biome-ignore lint/suspicious/noExplicitAny: operation outputs are checked with expect
export type Any = any;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Tuesday 2026-09-22, 10:00 in Chicago: inside the default sending window of US leads. */
export const TUESDAY_MORNING = "2026-09-22T15:00:00.000Z";
/** The engine's public address (OPENOUTBOUND_BASE_URL) in every world. */
export const PUBLIC_BASE_URL = "https://outbound.example.com";
/** The client's booking page (Calendly: the engine tags it with each person's booking code). */
export const BOOKING_URL = "https://calendly.com/brightline-demo/intro-call";

/** A complete classifier answer (the fields the scenario does not care about are neutral). */
export function classification(
  category: ClassifyOutput["category"],
  extra: Partial<ClassifyOutput> = {},
): ClassifyOutput {
  return {
    category,
    confidence: 0.94,
    sentiment: ["interested", "meeting_request"].includes(category) ? "positive" : "neutral",
    summary: `The prospect's reply (${category.replace(/_/g, " ")}).`,
    language: "en",
    return_date: null,
    follow_up_date: null,
    referral: null,
    question: null,
    left_company: false,
    asks_if_bot: false,
    suspicious: false,
    proposed_time: null,
    privacy_kind: null,
    facts: [],
    company_hold: null,
    ...extra,
  };
}

function firstWord(text: string): string {
  return text.trim().split(/[\s(,]+/)[0] ?? "there";
}

/** A writer answer that passes the deterministic checks (names the lead, one question). */
export function campaignEmail(vars: Pick<WritingVars, "prospect" | "first_touch">) {
  const name = /Name: ([^\n,(]+)/.exec(vars.prospect)?.[1]?.trim().split(/\s+/)[0] ?? "there";
  return {
    subject: vars.first_touch ? "front desk coverage" : "lunch rush follow up",
    body: vars.first_touch
      ? `Hi ${name}, dental groups that open a new location often find the front desk juggling twice the calls while the team settles in. We answer overflow calls so patients never hit voicemail during the lunch rush. Would that be useful for your practice this quarter?`
      : `Hi ${name}, a short follow up on the front desk note. Is covering the lunch rush something your team is looking at before the end of the year?`,
    angle: "Overflow call coverage for busy front desks",
    signals_used: [],
    facts_used: [],
  };
}

/** The default reply draft: offers the booking link when the engine passed one, else holds. */
export function replyDraft(vars: Pick<DraftVars, "prospect" | "bookingUrl">) {
  const name = firstWord(vars.prospect);
  return {
    subject: null,
    body: vars.bookingUrl
      ? `Hi ${name}, glad this is useful. Pick a slot that suits you here so it lands on both calendars: ${vars.bookingUrl}`
      : `Hi ${name}, thanks for getting back to me. I will check with the team and come back to you shortly.`,
    used_fact_ids: [],
    needs_human: false,
    needs_human_reason: null,
  };
}

export const PASSING_CHECK = { verdict: "pass", confidence: 0.95, issues: [] } as const;

export interface WorldOptions {
  /** Clock start. Default: a Tuesday morning in the US. */
  now?: string;
  name?: string;
  timezone?: string;
  /** Workspace settings on top of the defaults below (company name, address, website). */
  settings?: WorkspaceSettingsInput;
  /** false: no fake brain (the runtime's provider-based brain, with no provider configured). */
  brain?: boolean;
  /** An existing engine: a second workspace on the same database and clock. */
  engine?: TestEngine;
  /** Mailbox overrides (default: an active sandbox mailbox with no warm-up ramp). */
  mailbox?: Partial<Mailbox>;
  /** Offer booking link (null for none). */
  bookingUrl?: string | null;
  /**
   * A new engine whose workspaces can switch to the agent brain with `useAgentBrain` (the others
   * keep the fake brain).
   */
  agentBrain?: boolean;
}

export interface Lead {
  person: Person;
  company: Company;
}

export interface World {
  engine: TestEngine;
  /** Shared by every workspace of the engine; answers by prompt id, records every call. */
  brain: FakeBrain;
  workspaceId: string;
  slug: string;
  target: SeedTarget;
  mailbox: Mailbox;
  offerId: string;
  /** Calls an operation through the executor as the test admin, in this workspace. */
  call<T = Any>(operationId: string, input?: unknown, options?: TestCallOptions): Promise<T>;
  /** A system context of the workspace (for the inbound path and webhooks-like entry points). */
  context(): Promise<OpContext>;
  /**
   * Adds a person (and a company, unless person.company_id names one) the way an import would
   * leave them.
   */
  lead(overrides?: { person?: Partial<Person>; company?: Partial<Company> }): Promise<Lead>;
  /** Classifier answer for replies that contain `fragment` (first match wins). */
  classifyReply(fragment: string, answer: ClassifyOutput): void;
  close(): Promise<void>;
}

/** Fake brain answers per workspace engine: replies are matched by a text fragment. */
function installDefaultAnswers(
  brain: FakeBrain,
  replies: Array<{ fragment: string; answer: ClassifyOutput }>,
) {
  brain.on("inbox.reply.classify", (vars: { reply: string }) => {
    const text = vars.reply.toLowerCase();
    const found = replies.find((entry) => text.includes(entry.fragment.toLowerCase()));
    return found?.answer ?? classification("other", { confidence: 0.6 });
  });
  brain.on("inbox.reply.draft", (vars: DraftVars) => replyDraft(vars));
  brain.on("inbox.reply.check", PASSING_CHECK);
  brain.on("inbox.reply.promises", { promises: [] });
  brain.on("campaign.email.write", (vars: WritingVars) => campaignEmail(vars));
  brain.on("campaign.email.check", PASSING_CHECK);
}

const shared = new WeakMap<
  TestEngine,
  {
    brain: FakeBrain;
    replies: Array<{ fragment: string; answer: ClassifyOutput }>;
    /** Workspaces that switched to the agent brain (engines started with `agentBrain`). */
    agentBrain?: Set<string>;
  }
>();

/**
 * The fake brain, except for workspaces in `agentWorkspaces`: their prompts go to the runtime's
 * provider-based brain, where the `agent` provider turns each one into an agent task.
 */
function routedBrain(fake: FakeBrain, agentWorkspaces: ReadonlySet<string>): BrainFactory {
  return (deps) => {
    const current = () =>
      typeof deps.workspaceId === "function" ? deps.workspaceId() : (deps.workspaceId ?? null);
    let runtime: BrainService | undefined;
    return {
      run(prompt, vars, options) {
        const workspaceId = options?.workspaceId ?? current();
        if (workspaceId && agentWorkspaces.has(workspaceId)) {
          runtime ??= createBrainService(deps);
          return runtime.run(prompt, vars, options);
        }
        return fake.run(prompt, vars, options);
      },
    };
  };
}

let worlds = 0;

/** A client workspace on a new (or the given) engine, ready to send (see module doc). */
export async function startWorld(options: WorldOptions = {}): Promise<World> {
  worlds += 1;
  let engine = options.engine;
  let state = engine ? shared.get(engine) : undefined;
  if (!engine) {
    const replies: Array<{ fragment: string; answer: ClassifyOutput }> = [];
    const brain = createFakeBrain();
    installDefaultAnswers(brain, replies);
    const agentBrain = options.agentBrain ? new Set<string>() : undefined;
    engine = await createTestEngine({
      now: options.now ?? TUESDAY_MORNING,
      // A public https address, like a live engine: real email needs it for its unsubscribe link.
      config: { baseUrl: PUBLIC_BASE_URL },
      ...(options.brain === false
        ? {}
        : { brain: agentBrain ? routedBrain(brain, agentBrain) : brain }),
    });
    state = { brain, replies, ...(agentBrain ? { agentBrain } : {}) };
    shared.set(engine, state);
  }
  if (!state) throw new Error("startWorld: the engine was not made by startWorld");
  const theEngine = engine;
  const name = options.name ?? `Brightline Answering ${worlds}`;
  const created = (await theEngine.call("workspaces.create", {
    name,
    timezone: options.timezone ?? "America/Chicago",
    settings: {
      company: {
        name,
        website: "https://brightline-answering.example.org",
        postal_address: "1 Example Way, Austin, TX 78701",
      },
      ...options.settings,
    },
  })) as { id: string; slug: string };
  const target: SeedTarget = { db: theEngine.db, workspace: { id: created.id } };
  const mailbox = await seedMailbox(target, {
    email: `sam${worlds}@brightline-answering.example.org`,
    from_name: "Sam Carter",
    daily_limit: 40,
    ramp: null,
    min_gap_seconds: 60,
    max_gap_seconds: 120,
    ...options.mailbox,
  });
  const call = <T = Any>(
    operationId: string,
    input: unknown = {},
    callOptions: TestCallOptions = {},
  ) => theEngine.call(operationId, input, { workspace: created.id, ...callOptions }) as Promise<T>;
  const bookingUrl = options.bookingUrl === undefined ? BOOKING_URL : options.bookingUrl;
  const offer = await call<{ id: string }>("offers.create", {
    name: "Overflow call answering",
    summary:
      "We answer overflow and lunch-time calls for dental groups so patients never hit voicemail.",
    ...(bookingUrl ? { booking_url: bookingUrl } : {}),
  });
  const replies = state.replies;
  return {
    engine: theEngine,
    brain: state.brain,
    workspaceId: created.id,
    slug: created.slug,
    target,
    mailbox,
    offerId: offer.id,
    call,
    context: () => theEngine.systemContext(created.id),
    async lead(overrides = {}) {
      // A colleague joins the company that person.company_id names.
      const existing = overrides.person?.company_id
        ? (
            await theEngine.db
              .select()
              .from(companies)
              .where(eq(companies.id, overrides.person.company_id))
          )[0]
        : undefined;
      // Rows get the engine's clock, not the database's wall clock, so "since" dates are stable.
      const stamps = { created_at: theEngine.clock.now(), updated_at: theEngine.clock.now() };
      const company = existing ?? (await seedCompany(target, { ...stamps, ...overrides.company }));
      const person = await seedPerson(target, {
        company_id: company.id,
        linkedin_url: null,
        ...stamps,
        ...overrides.person,
      });
      return { person, company };
    },
    classifyReply(fragment, answer) {
      replies.unshift({ fragment, answer });
    },
    close: () => theEngine.close(),
  };
}

/**
 * The workspace switches its brain to the connected agent (provider `agent`): from now on each
 * prompt of the workspace becomes an agent task. Needs an engine started with `agentBrain`.
 */
export async function useAgentBrain(world: World): Promise<void> {
  const state = shared.get(world.engine);
  if (!state?.agentBrain) throw new Error("useAgentBrain: start the engine with agentBrain: true");
  await world.call("providers.set", { slot: "brain", provider: "agent" });
  state.agentBrain.add(world.workspaceId);
}

/**
 * Runs every due job (due schedules first) until nothing is left to run at the current time.
 * Returns how many jobs ran.
 */
export async function settle(engine: TestEngine): Promise<number> {
  let total = 0;
  for (let round = 0; round < 20; round++) {
    const result = await engine.runJobs({ max: 500 });
    total += result.ran;
    if (result.ran === 0) break;
  }
  return total;
}

/** Moves the clock forward and runs what came due. */
export async function advance(engine: TestEngine, ms: number): Promise<number> {
  engine.advance(ms);
  return settle(engine);
}

/**
 * Moves the clock in steps (running due jobs after each) until `done()` holds. Fails the test
 * with `what` when it never does within `max` steps.
 */
export async function until(
  engine: TestEngine,
  what: string,
  done: () => Promise<boolean>,
  options: { stepMs?: number; max?: number } = {},
): Promise<void> {
  const stepMs = options.stepMs ?? 5 * MINUTE;
  const max = options.max ?? 200;
  await settle(engine);
  for (let step = 0; step < max; step++) {
    if (await done()) return;
    await advance(engine, stepMs);
  }
  if (await done()) return;
  throw new Error(`Timed out waiting until ${what}`);
}

/** Messages of the workspace, oldest first, optionally narrowed. */
export async function messagesOf(
  world: Pick<World, "engine" | "workspaceId">,
  filter: { personId?: string; threadId?: string | null; direction?: "inbound" | "outbound" } = {},
): Promise<Message[]> {
  return world.engine.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, world.workspaceId),
        ...(filter.personId ? [eq(messages.person_id, filter.personId)] : []),
        ...(filter.threadId ? [eq(messages.thread_id, filter.threadId)] : []),
        ...(filter.direction ? [eq(messages.direction, filter.direction)] : []),
      ),
    )
    .orderBy(asc(messages.created_at), asc(messages.id));
}

export async function messageById(world: Pick<World, "engine">, id: string): Promise<Message> {
  const [row] = await world.engine.db.select().from(messages).where(eq(messages.id, id));
  if (!row) throw new Error(`message ${id} is gone`);
  return row;
}

/** Stored events of the workspace (oldest first), optionally of some types. */
export async function eventsOf(
  world: Pick<World, "engine" | "workspaceId">,
  ...types: EventType[]
): Promise<Array<{ type: string; data: Any; subject_id: string | null }>> {
  const rows = await world.engine.db
    .select({ type: events.type, data: events.data, subject_id: events.subject_id })
    .from(events)
    .where(
      and(
        eq(events.workspace_id, world.workspaceId),
        ...(types.length > 0 ? [inArray(events.type, types)] : []),
      ),
    )
    .orderBy(asc(events.occurred_at), asc(events.id));
  return rows;
}

/** Problems of the workspace, optionally of one kind. */
export async function problemsOf(world: Pick<World, "engine" | "workspaceId">, kind?: string) {
  return world.engine.db
    .select()
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, world.workspaceId),
        ...(kind ? [eq(problems.kind, kind as never)] : []),
      ),
    )
    .orderBy(asc(problems.created_at), asc(problems.id));
}

export async function enrollmentsOf(
  world: Pick<World, "engine" | "workspaceId">,
  personId: string,
) {
  return world.engine.db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.workspace_id, world.workspaceId), eq(enrollments.person_id, personId)),
    )
    .orderBy(asc(enrollments.enrolled_at), asc(enrollments.id));
}

export async function threadById(world: Pick<World, "engine">, id: string) {
  const [row] = await world.engine.db.select().from(threads).where(eq(threads.id, id));
  if (!row) throw new Error(`thread ${id} is gone`);
  return row;
}

export interface CampaignOptions {
  name?: string;
  steps?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  offerId?: string | null;
}

/** Creates a campaign sending from the world's mailbox (review only when the checker is unsure). */
export async function createCampaign(world: World, options: CampaignOptions = {}): Promise<Any> {
  return world.call("campaigns.create", {
    name: options.name ?? "Dental groups",
    ...(options.offerId === null ? {} : { offer_id: options.offerId ?? world.offerId }),
    steps: options.steps ?? [
      { type: "email", config: { style: "free", instruction: "Lead with their front desk." } },
      { type: "email", delay_days: 3, config: { mode: "reply", style: "free", max_words: 70 } },
    ],
    settings: {
      review_level: "unsure",
      senders: { mailbox_ids: [world.mailbox.id] },
      writing: { instructions: "Offer overflow call answering for dental groups." },
      ...options.settings,
    },
  });
}

/** Enrolls people and launches the campaign (as the test admin). */
export async function enrollAndLaunch(world: World, campaignId: string, personIds: string[]) {
  const enrolled = await world.call<Any>("campaigns.enroll", {
    campaign_id: campaignId,
    person_ids: personIds,
  });
  expect(enrolled.enrolled).toBe(personIds.length);
  const launched = await world.call<Any>("campaigns.launch", { campaign_id: campaignId });
  expect(launched.status).toBe("active");
  return enrolled;
}

/** Runs the sequencer and the sender until the person's first campaign email is sent. */
export async function firstEmailSent(world: World, personId: string): Promise<Message> {
  let sent: Message | undefined;
  await until(world.engine, "the first campaign email is sent", async () => {
    const rows = await messagesOf(world, { personId, direction: "outbound" });
    sent = rows.find((row) => row.status === "sent" && row.action === "email");
    return Boolean(sent);
  });
  if (!sent) throw new Error("unreachable");
  return sent;
}

let replySeq = 0;

/**
 * A prospect's email reply to one of our sent messages, through the inbound path (what IMAP
 * sync hands over), then every job that follows it (classification, actions, drafts).
 */
export async function receiveReply(
  world: World,
  to: Message,
  text: string,
  options: { from?: string; subject?: string; settle?: boolean } = {},
) {
  replySeq += 1;
  const ctx = await world.context();
  const [person] = to.person_id
    ? await world.engine.db.select().from(people).where(eq(people.id, to.person_id))
    : [];
  const from = options.from ?? person?.email ?? to.to_address ?? "prospect@example.com";
  const domain = from.slice(from.lastIndexOf("@") + 1);
  const result = await ingestInboundEmail(ctx, {
    mailboxId: to.mailbox_id ?? world.mailbox.id,
    from,
    to: [to.from_address ?? world.mailbox.email],
    subject: options.subject ?? `Re: ${to.subject ?? ""}`,
    text,
    headers: {},
    messageIdHeader: `<reply-${replySeq}@${domain}>`,
    ...(to.message_id_header
      ? { inReplyTo: to.message_id_header, references: [to.message_id_header] }
      : {}),
    receivedAt: world.engine.clock.now(),
  });
  if (options.settle !== false) await settle(world.engine);
  return result;
}

/** The engine's public HTTP routes (webhooks) on a Hono app, as the HTTP door mounts them. */
export function webhookApp(world: Pick<World, "engine">): Hono {
  const app = new Hono();
  for (const register of world.engine.httpRoutes()) register(app, { engine: world.engine });
  return app;
}

/** POSTs a JSON body to a webhook path and returns the status and the parsed answer. */
export async function postJson(
  app: Hono,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Any }> {
  const response = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** The path part of a webhook URL the engine handed out. */
export function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** A Calendly `invitee.created` or `invitee.canceled` delivery (shape of the public docs). */
export function calendlyDelivery(input: {
  event: "invitee.created" | "invitee.canceled";
  email: string;
  name: string;
  ref: string | null;
  eventId: string;
  start: string;
  end: string;
}) {
  const eventUri = `https://api.calendly.com/scheduled_events/${input.eventId}`;
  const canceled = input.event === "invitee.canceled";
  return {
    created_at: "2026-09-22T15:30:00.000000Z",
    created_by: "https://api.calendly.com/users/USERBRIGHTLINE01",
    event: input.event,
    payload: {
      cancel_url: `https://calendly.com/cancellations/${input.eventId}`,
      created_at: "2026-09-22T15:29:58.000000Z",
      email: input.email,
      event: eventUri,
      name: input.name,
      new_invitee: null,
      no_show: null,
      old_invitee: null,
      questions_and_answers: [],
      reschedule_url: `https://calendly.com/reschedulings/${input.eventId}`,
      rescheduled: false,
      status: canceled ? "canceled" : "active",
      timezone: "America/Chicago",
      tracking: {
        utm_campaign: null,
        utm_source: input.ref ? "openoutbound" : null,
        utm_medium: null,
        utm_content: input.ref,
        utm_term: null,
        salesforce_uuid: null,
      },
      ...(canceled
        ? {
            cancellation: {
              canceled_by: input.name,
              reason: "Something came up",
              canceler_type: "invitee",
              created_at: "2026-09-23T09:59:58.000000Z",
            },
          }
        : {}),
      updated_at: "2026-09-22T15:29:58.000000Z",
      uri: `${eventUri}/invitees/INV${input.eventId}`,
      scheduled_event: {
        uri: eventUri,
        name: "Intro call",
        status: canceled ? "canceled" : "active",
        start_time: input.start,
        end_time: input.end,
        event_type: "https://api.calendly.com/event_types/TYPEBRIGHTLINE01",
        location: { type: "google_conference", status: "pushed" },
        invitees_counter: { total: 1, active: canceled ? 0 : 1, limit: 1 },
        created_at: "2026-09-22T15:29:58.000000Z",
        updated_at: "2026-09-22T15:29:58.000000Z",
        event_memberships: [{ user: "https://api.calendly.com/users/USERBRIGHTLINE01" }],
        event_guests: [],
      },
    },
  };
}

/** A notification as a signed-webhook channel receives it. */
export interface Alert {
  type: string;
  title: string;
  lines: string[];
  severity: "info" | "warning" | "critical";
  event: string | null;
}

/**
 * Adds a signed-webhook notification channel for curated notifications (what a team gets in
 * Slack or email) and returns the list its deliveries land in.
 */
export async function alertsChannel(world: World): Promise<Alert[]> {
  const url = `https://alerts.brightline-answering.example.org/${world.slug}`;
  const received: Alert[] = [];
  world.engine.fetch.route(
    url,
    (request) => {
      received.push(JSON.parse(String(request.init?.body ?? "{}")) as Alert);
      return { status: 200, json: { ok: true } };
    },
    "POST",
  );
  await world.call("notifications.create", { type: "webhook", name: "Team alerts", url });
  return received;
}
