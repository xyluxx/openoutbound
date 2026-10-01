/**
 * Acceptance scenario 6, workspace separation. One engine serves two clients, Brightline
 * Answering and Northgate Reception, and both work the same lead: Dana Kim at Oakridge Dental,
 * with the same email address and the same company domain. Each client files its own facts and
 * notes, keeps its own lessons, strategy notes, proposals, meetings and problems, and later lets
 * the connected agent answer its prompts (agent tasks). Every read path of one client shows its
 * own records and nothing of the other's: the lead and company files, the timeline, the
 * strategy page, the change log and proposals, the event feed and its consumers, problems, the
 * operating state, next actions, meetings, the setup export, the writer's and the reply
 * drafter's context and the agent tasks. An agent key bound to one client gets not_found for the
 * other client's ids and forbidden for the other workspace.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { Principal } from "../../../src/core/context.js";
import { isOpenOutboundError } from "../../../src/core/errors.js";
import type { Message } from "../../../src/db/schema/index.js";
import type { BrainCall } from "../../../src/testing/fake-brain.js";
import {
  type Any,
  advance,
  classification,
  createCampaign,
  enrollAndLaunch,
  firstEmailSent,
  MINUTE,
  problemsOf,
  receiveReply,
  startWorld,
  useAgentBrain,
  type World,
} from "./support.js";

let a: World | undefined;
afterAll(async () => {
  await a?.close();
});

const DANA = {
  first_name: "Dana",
  last_name: "Kim",
  full_name: "Dana Kim",
  email: "dana.kim@oakridge-dental.example.com",
};
const OAKRIDGE = { name: "Oakridge Dental", domain: "oakridge-dental.example.com" };

/** What one client knows and does about Dana (every text is its own). */
interface ClientStory {
  name: string;
  campaign: string;
  companyFact: string;
  personFact: string;
  note: string;
  lesson: string;
  agentNotes: string;
  proposal: string;
  /** Dana's reply, the fragment the classifier answer matches and the fact it carries. */
  reply: string;
  replyMatch: string;
  replyFact: string;
  proposedTime: { text: string; start: string; timezone: string };
  meetingStart: string;
  meetingNotes: string;
  /** A later message, answered by the connected agent (agent task). */
  laterReply: string;
}

const BRIGHTLINE: ClientStory = {
  name: "Brightline Answering",
  campaign: "Texas dental groups",
  companyFact: "Oakridge runs Dentrix for scheduling at all three locations",
  personFact: "Dana prefers calls before 9am",
  note: "Met Dana at the Austin dental expo booth",
  lesson: "Short subject lines win with multi-location groups",
  agentNotes: "Focus on multi-location groups in Texas",
  proposal: "Send fifteen new leads a day in Texas dental groups",
  reply:
    "Dana here. Our budget for front desk help resets in April. Thursday at 3pm works for a quick call.",
  replyMatch: "budget for front desk help resets in april",
  replyFact: "Front desk budget resets in April",
  proposedTime: {
    text: "Thursday at 3pm",
    start: "2026-09-24T15:00:00-05:00",
    timezone: "America/Chicago",
  },
  meetingStart: "2026-09-24T15:00:00-05:00",
  meetingNotes: "Intro call booked by the Brightline team",
  laterReply: "Adding our office manager Priyanka to Thursday's call, if that is fine.",
};

const NORTHGATE: ClientStory = {
  name: "Northgate Reception",
  campaign: "Colorado practices",
  companyFact: "Oakridge moved to Open Dental last spring",
  personFact: "Dana prefers email over phone calls",
  note: "Referred by a Denver customer of Northgate",
  lesson: "After-hours coverage lands with single practices",
  agentNotes: "Focus on single practices in Colorado",
  proposal: "Send fifteen new leads a day in Colorado practices",
  reply: "Hello, Dana from Oakridge. We lose calls every lunch hour. Could we talk Friday at 10am?",
  replyMatch: "we lose calls every lunch hour",
  replyFact: "Oakridge loses calls every lunch hour",
  proposedTime: {
    text: "Friday at 10am",
    start: "2026-09-25T10:00:00-05:00",
    timezone: "America/Chicago",
  },
  meetingStart: "2026-09-25T10:00:00-05:00",
  meetingNotes: "Discovery call booked by the Northgate team",
  laterReply: "Could you send your price list for the weekend service before Friday?",
};

interface Client {
  world: World;
  story: ClientStory;
  person: Any;
  company: Any;
  campaign: Any;
  first: Message;
  reply: { messageId: string | null; threadId: string | null };
  factIds: string[];
  lessonId: string;
  proposal: Any;
  problemId: string;
  meeting: Any;
  draftCalls: BrainCall[];
  taskIds: string[];
}

/** The client's world: its files on Dana, strategy, a campaign, her reply and the meeting. */
async function setUpClient(world: World, story: ClientStory): Promise<Client> {
  const { person, company } = await world.lead({ person: DANA, company: OAKRIDGE });
  const companyFact = await world.call<Any>("leads.add_fact", {
    company_id: company.id,
    scope: "company",
    kind: "fact",
    text: story.companyFact,
  });
  const personFact = await world.call<Any>("leads.add_fact", {
    person_id: person.id,
    kind: "preference",
    text: story.personFact,
  });
  const note = await world.call<Any>("leads.add_note", { person_id: person.id, text: story.note });
  const lesson = await world.call<Any>("knowledge.create", {
    kind: "lesson",
    title: story.lesson,
    body: `${story.lesson}.`,
  });
  await world.call("workspaces.update", {
    settings: { strategy: { agent_notes: story.agentNotes } },
  });
  const campaign = await createCampaign(world, { name: story.campaign });
  await enrollAndLaunch(world, campaign.id, [person.id]);
  const first = await firstEmailSent(world, person.id);
  const proposal = await world.call<Any>(
    "changes.propose",
    {
      title: story.proposal,
      operation: "campaigns.update",
      input: { campaign_id: campaign.id, settings: { daily_new_leads: 15 } },
    },
    { reason: `The owner asked: ${story.proposal}.` },
  );
  expect(proposal).toMatchObject({ status: "applied", change_id: expect.stringMatching(/^chg_/) });

  // Dana answers with a time and a fact: the fact is filed, a draft waits, someone should book.
  world.classifyReply(
    story.replyMatch,
    classification("meeting_request", {
      proposed_time: story.proposedTime,
      facts: [{ kind: "fact", text: story.replyFact, applies_to: "company", expires_on: null }],
    }),
  );
  const callsBefore = world.brain.calls.length;
  const reply = await receiveReply(world, first, story.reply);
  const draftCalls = world.brain.calls
    .slice(callsBefore)
    .filter(
      (call) =>
        call.promptId === "inbox.reply.draft" && JSON.stringify(call.vars).includes(story.reply),
    );
  expect(draftCalls.length).toBeGreaterThan(0);
  const [problem] = await problemsOf(world, "meeting_to_book");
  expect(problem?.person_id).toBe(person.id);
  const meeting = await world.call<Any>("meetings.record", {
    person_id: person.id,
    start_at: story.meetingStart,
    notes: story.meetingNotes,
  });
  return {
    world,
    story,
    person,
    company,
    campaign,
    first,
    reply,
    factIds: [companyFact.id, personFact.id, note.id],
    lessonId: lesson.id,
    proposal,
    problemId: problem?.id ?? "",
    meeting,
    draftCalls,
    taskIds: [],
  };
}

/** Every id and text of a client that must never show up in the other client's reads. */
function markersOf(client: Client): string[] {
  const { story } = client;
  return [
    client.world.workspaceId,
    client.world.slug,
    story.name,
    client.person.id,
    client.company.id,
    client.campaign.id,
    client.first.id,
    client.reply.messageId ?? "",
    client.reply.threadId ?? "",
    ...client.factIds,
    client.lessonId,
    client.proposal.id,
    client.proposal.change_id,
    client.problemId,
    client.meeting.id,
    ...client.taskIds,
    story.campaign,
    story.companyFact,
    story.personFact,
    story.note,
    story.lesson,
    story.agentNotes,
    story.proposal,
    story.reply,
    story.replyFact,
    story.meetingNotes,
    story.laterReply,
  ].filter(Boolean);
}

/** The output shows its own client's `expected` and nothing of the other client. */
function expectOnly(path: string, output: unknown, own: string[], other: Client) {
  const text = JSON.stringify(output);
  const leaked = markersOf(other).filter((marker) => text.includes(marker));
  expect(leaked, `${path} shows the other client's records`).toEqual([]);
  for (const marker of own) expect(text, `${path} misses its own ${marker}`).toContain(marker);
}

async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!isOpenOutboundError(error)) throw new Error(`expected an engine error, got ${error}`);
  return error;
}

/** Every read path of one client, as `read` (a key bound to it, or its admin) sees them. */
async function checkReads(
  own: Client,
  other: Client,
  read: <T = Any>(operationId: string, input?: unknown) => Promise<T>,
) {
  const { story } = own;
  expectOnly(
    "get_lead",
    await read("leads.get", { person_id: own.person.id }),
    [story.personFact, story.note],
    other,
  );
  expectOnly(
    "companies",
    await read("companies.get", { company_id: own.company.id }),
    [story.companyFact, story.replyFact],
    other,
  );
  expectOnly(
    "timeline",
    await read("leads.timeline", { person_id: own.person.id }),
    [own.reply.messageId ?? "", own.meeting.id],
    other,
  );
  expectOnly(
    "company timeline",
    await read("leads.timeline", { company_id: own.company.id }),
    [story.companyFact],
    other,
  );
  expectOnly(
    "strategy page",
    await read("strategy.get"),
    [story.agentNotes, story.lesson, own.proposal.change_id],
    other,
  );
  expectOnly(
    "change log",
    await read("changes.list"),
    [own.proposal.change_id, own.campaign.id],
    other,
  );
  expectOnly("proposals", await read("proposals.list"), [own.proposal.id], other);
  expectOnly(
    "problems",
    await read("problems.list", { status: ["open", "snoozed", "resolved"] }),
    [own.problemId],
    other,
  );
  expectOnly(
    "operating state",
    await read("operating.state"),
    [own.meeting.id, own.campaign.id],
    other,
  );
  expectOnly(
    "next actions",
    await read("operating.next_actions", { hours: 168 }),
    [own.meeting.id],
    other,
  );
  expectOnly(
    "explain",
    await read("operating.explain", { person_id: own.person.id }),
    [own.person.id],
    other,
  );
  expectOnly("meetings", await read("meetings.list"), [own.meeting.id, story.meetingNotes], other);
  expectOnly(
    "setup export",
    await read("workspaces.export_setup", { include_lessons: true, include_company: true }),
    [story.lesson, story.name],
    other,
  );

  // The event feed from the start, with the CRM consumer: only the client's own events.
  const feed = await read<Any>("events.list", { consumer: "crm", limit: 200 });
  expectOnly("event feed", feed, [own.person.id, own.meeting.id], other);
  expect(feed.items.length).toBeGreaterThan(0);
  const acked = await read<Any>("events.ack", { consumer: "crm", cursor: feed.next_cursor });
  expect(acked).toMatchObject({ consumer: "crm" });
  const consumers = await read<Any>("events.consumers");
  expect(consumers.items).toEqual([expect.objectContaining({ name: "crm", lag: 0 })]);
  expectOnly("event consumers", consumers, [], other);

  // The writer's context: a preview of the campaign's first email for Dana.
  const before = own.world.brain.calls.length;
  await read("campaigns.preview", { campaign_id: own.campaign.id, person_ids: [own.person.id] });
  const writer = own.world.brain.calls
    .slice(before)
    .filter((call) => call.promptId === "campaign.email.write");
  expect(writer.length).toBeGreaterThan(0);
  expectOnly(
    "writer context",
    writer.map((call) => call.vars),
    [story.companyFact, story.replyFact, story.lesson],
    other,
  );
  // The reply drafter's context when Dana's reply came in.
  expectOnly(
    "reply draft context",
    own.draftCalls.map((call) => call.vars),
    [story.reply, story.lesson],
    other,
  );
}

describe("acceptance: workspace separation", () => {
  it("shows each client only its own records on every read path", async () => {
    a = await startWorld({ name: BRIGHTLINE.name, agentBrain: true });
    const b = await startWorld({
      engine: a.engine,
      name: NORTHGATE.name,
      settings: {
        company: {
          name: NORTHGATE.name,
          website: "https://northgate-reception.example.org",
          postal_address: "2 Example Road, Denver, CO 80202",
        },
      },
      mailbox: { email: "riley@northgate-reception.example.org", from_name: "Riley Moss" },
    });
    const brightline = await setUpClient(a, BRIGHTLINE);
    const northgate = await setUpClient(b, NORTHGATE);
    // Same email and domain, two separate records.
    expect(brightline.person.id).not.toBe(northgate.person.id);
    expect(brightline.company.id).not.toBe(northgate.company.id);

    // A minute later (the event feed shows events once they are 2 seconds old), Brightline's
    // agent reads with a key bound to its workspace, and Northgate's admin reads too.
    await advance(a.engine, MINUTE);
    const key = await a.call<Any>("keys.create", { name: "Brightline agent", kind: "agent" });
    const agent = (await a.engine.authenticate(key.key, "mcp")) as Principal;
    expect(agent).toMatchObject({ type: "agent", workspaceId: a.workspaceId });
    const asAgent = <T = Any>(operationId: string, input: unknown = {}) =>
      a?.engine.call(operationId, input, { principal: agent }) as Promise<T>;
    await checkReads(brightline, northgate, asAgent);
    await checkReads(northgate, brightline, b.call);

    // Both clients let the connected agent answer their prompts: Dana's next message becomes
    // an agent task in each workspace.
    await useAgentBrain(a);
    await useAgentBrain(b);
    for (const client of [brightline, northgate]) {
      await receiveReply(client.world, client.first, client.story.laterReply);
    }
    const brightlineTasks = await asAgent<Any>("agent_tasks.list");
    const northgateTasks = await b.call<Any>("agent_tasks.list");
    brightline.taskIds = brightlineTasks.items.map((item: Any) => item.id);
    northgate.taskIds = northgateTasks.items.map((item: Any) => item.id);
    expect(brightline.taskIds.length).toBeGreaterThan(0);
    expect(northgate.taskIds.length).toBeGreaterThan(0);
    expectOnly("agent tasks", brightlineTasks, [], northgate);
    expectOnly("agent tasks", northgateTasks, [], brightline);
    const brightlineTask = await asAgent<Any>("agent_tasks.get", {
      task_id: brightline.taskIds[0],
    });
    expectOnly("agent task", brightlineTask, [BRIGHTLINE.laterReply], northgate);
    const northgateTask = await b.call<Any>("agent_tasks.get", { task_id: northgate.taskIds[0] });
    expectOnly("agent task", northgateTask, [NORTHGATE.laterReply], brightline);

    // Brightline's key cannot reach Northgate's records by id...
    const theirs: Array<[string, Record<string, unknown>]> = [
      ["leads.get", { person_id: northgate.person.id }],
      ["companies.get", { company_id: northgate.company.id }],
      ["leads.timeline", { person_id: northgate.person.id }],
      ["operating.explain", { person_id: northgate.person.id }],
      ["messages.get", { message_id: northgate.first.id }],
      ["threads.get", { thread_id: northgate.reply.threadId }],
      ["meetings.get", { meeting_id: northgate.meeting.id }],
      ["problems.get", { problem_id: northgate.problemId }],
      ["proposals.get", { proposal_id: northgate.proposal.id }],
      ["changes.get", { change_id: northgate.proposal.change_id }],
      ["agent_tasks.get", { task_id: northgate.taskIds[0] }],
      ["agent_tasks.submit", { task_id: northgate.taskIds[0], decline_reason: "Not ours." }],
      ["leads.add_fact", { person_id: northgate.person.id, kind: "fact", text: "Not ours" }],
    ];
    for (const [operationId, input] of theirs) {
      const error = await errorOf(asAgent(operationId, input));
      expect(error.code, `${operationId} with another client's id`).toBe("not_found");
    }
    // ...nor Northgate's workspace itself.
    for (const operationId of ["strategy.get", "operating.state", "problems.list"]) {
      const error = await errorOf(
        a.engine.call(operationId, {}, { principal: agent, workspace: b.workspaceId }),
      );
      expect(error.code, `${operationId} in the other workspace`).toBe("forbidden");
    }
    // Northgate's task is still open: nothing Brightline's key did touched it.
    const stillOpen = await b.call<Any>("agent_tasks.get", { task_id: northgate.taskIds[0] });
    expect(stillOpen.status).toBe("open");
  });
});
