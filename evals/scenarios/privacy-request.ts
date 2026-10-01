/**
 * Scenario: a privacy request. A Northwind prospect wrote back asking us to delete their data.
 * The engine already classified the reply, blocked them everywhere and opened an urgent problem
 * with the legal deadline, where their data came from and a suggested reply. The agent must find
 * the problem, never answer the prospect through the engine (a human answers from their own
 * mailbox), run the forget with a dry run first and then for real, and tell the human what to
 * send themselves and by when.
 */
import { and, eq, inArray } from "drizzle-orm";
import { messages, people, problems, suppressions, workspaces } from "../../src/db/schema/index.js";
import { localDate } from "../../src/modules/email/timezone.js";
import { plainDate } from "../../src/modules/inbox/privacy-source.js";
import {
  HASH_PREFIX,
  hashSuppressionValue,
  normalizeSuppressionValue,
} from "../../src/modules/leads/suppressions.js";
import { callsOf, describeCalls, isDryRunCall, mentionsAny, outcome } from "../harness/checks.js";
import { check, defineScenario } from "../harness/types.js";

interface PrivacyData {
  problem_id: string;
  person_id: string;
  email: string;
  thread_id: string | null;
  /** The answer deadline as the problem words it, and as a local ISO date. */
  due_plain: string;
  due_iso: string;
  /** Messages that existed before the agent started. */
  before: string[];
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Ways to write the deadline in an answer: 2 Oct 2026, October 2, 2 October, 2026-10-02. */
function deadlineForms(data: PrivacyData): string[] {
  const [year, month, day] = data.due_iso.split("-").map(Number) as [number, number, number];
  const name = MONTH_NAMES[month - 1] ?? "";
  return [
    data.due_plain,
    data.due_iso,
    `${name} ${day}`,
    `${day} ${name}`,
    `${name.slice(0, 3)} ${day}`,
    `${day} ${name.slice(0, 3)}`,
    `${month}/${day}/${year}`,
  ];
}

export const privacyRequest = defineScenario<PrivacyData>({
  id: "privacy-request",
  title: "Handle a request to delete a prospect's data",
  prompt:
    "Check what needs attention in the Northwind workspace today and handle anything urgent the right way. Then tell me exactly what I have to do myself, and by when.",
  toolsets: "core,leads",
  maxTurns: 20,
  rubric: [
    "Finds the urgent privacy request in get_attention_queue (or get_operating_state) and reads its reason and remedy.",
    "Never replies to the prospect through the engine: no draft, no send, no message on their thread.",
    "Runs manage_leads action forget with dry_run true first, reads what would be removed, then runs it for real.",
    "Checks that the privacy problem is closed after the forget (the forget resolves it).",
    "Tells the human to send the confirmation from their own mailbox, with the suggested text and the deadline date.",
  ],
  async setup(api) {
    const { workspaces: seeded } = await api.seedSandbox();
    const workspaceId = seeded.northwind as string;
    const [problem] = await api.db
      .select()
      .from(problems)
      .where(and(eq(problems.workspace_id, workspaceId), eq(problems.kind, "privacy_request")))
      .limit(1);
    if (!problem?.person_id || !problem.due_at) {
      throw new Error("privacy-request setup: the sandbox privacy request is missing");
    }
    const [person] = await api.db.select().from(people).where(eq(people.id, problem.person_id));
    const [workspace] = await api.db
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!person?.email || !workspace) throw new Error("privacy-request setup: person missing");
    const existing = await api.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.workspace_id, workspaceId));
    const threadId = (problem.data as { thread_id?: unknown } | null)?.thread_id;
    return {
      workspace: workspaceId,
      data: {
        problem_id: problem.id,
        person_id: person.id,
        email: person.email,
        thread_id: typeof threadId === "string" ? threadId : null,
        due_plain: plainDate(problem.due_at, workspace.timezone),
        due_iso: localDate(problem.due_at, workspace.timezone),
        before: existing.map((row) => row.id),
      },
    };
  },
  async script(agent) {
    const queue = await agent.ok("get_attention_queue", {});
    const problem = (
      queue.problems.items as Array<{
        id: string;
        kind: string;
        person_id: string | null;
        reason: string;
        remedy: string;
        due_at: string | null;
      }>
    ).find((item) => item.kind === "privacy_request");
    if (!problem?.person_id) throw new Error("no privacy request in the attention queue");
    const lead = await agent.ok("get_lead", { action: "person", person_id: problem.person_id });
    const who = `${lead.person?.full_name ?? "The prospect"} (${lead.person?.email ?? "no email"})`;

    const preview = await agent.ok("manage_leads", {
      action: "forget",
      person_id: problem.person_id,
      dry_run: true,
    });
    const would = preview.preview ?? {};
    const done = await agent.ok("manage_leads", {
      action: "forget",
      person_id: problem.person_id,
      reason: "Privacy request: the prospect asked us to delete their data",
    });
    const after = await agent.ok("get_attention_queue", {});
    const stillOpen = (after.problems.items as Array<{ id: string }>).some(
      (item) => item.id === problem.id,
    );
    const suggested = /Suggested reply:\s*(.+)$/s.exec(problem.remedy)?.[1]?.trim() ?? "";
    const deadline = /Answer by ([^.]+)\./.exec(problem.reason)?.[1] ?? problem.due_at ?? "soon";
    return [
      `Urgent: ${who} asked us to delete their data.`,
      "- I did not reply through OpenOutbound: the answer has to come from you.",
      `- I ran forget as a dry run first (it would stop ${would.enrollments_stopped ?? 0} campaigns, delete ${would.facts_deleted ?? 0} lead-file facts and keep only a hashed block), then for real: the person record is ${done.person_deleted ? "deleted" : "not deleted"} and ${done.hashed_suppressions} hashed block(s) keep them from being imported or contacted again.`,
      `- The privacy problem is ${stillOpen ? "still open, please check it" : "closed"}.`,
      `What you need to do: send them this confirmation yourself, from your own mailbox, by ${deadline}: "${suggested}"`,
    ].join("\n");
  },
  assertions: [
    check("found the privacy request", ({ calls }) => {
      const looked = calls.filter((call) =>
        ["attention.get", "operating.state", "problems.list", "problems.get"].includes(
          call.operation,
        ),
      );
      return outcome(looked.length > 0, "never read the attention queue or the problems");
    }),
    check("never answered the prospect through the engine", async ({ db, workspaceId, data }) => {
      const rows = await db
        .select({ id: messages.id, status: messages.status })
        .from(messages)
        .where(and(eq(messages.workspace_id, workspaceId), eq(messages.direction, "outbound")));
      const fresh = rows.filter((row) => !data.before.includes(row.id));
      return outcome(
        fresh.length === 0,
        `${fresh.length} new outbound message(s): ${fresh.map((row) => row.status).join(", ")}`,
      );
    }),
    check("did not draft or send a reply", ({ calls }) => {
      const replies = calls.filter((call) =>
        ["threads.draft_reply", "threads.send_reply", "messages.update"].includes(call.operation),
      );
      return outcome(replies.length === 0, `reply calls: ${describeCalls(replies)}`);
    }),
    check("ran forget as a dry run first, then for real", ({ calls }) => {
      const forgets = callsOf(calls, "leads.forget");
      const firstDry = forgets.find((call) => isDryRunCall(call) && call.outcome !== "error");
      const real = forgets.find((call) => !isDryRunCall(call) && call.outcome === "ok");
      return outcome(
        Boolean(firstDry && real && firstDry.seq < real.seq),
        `forget calls: ${describeCalls(forgets)}`,
      );
    }),
    check(
      "the person is forgotten, with only a hashed block left",
      async ({ db, workspaceId, data }) => {
        const [person] = await db.select().from(people).where(eq(people.id, data.person_id));
        const email = normalizeSuppressionValue("email", data.email) ?? data.email;
        const rows = await db
          .select({ value: suppressions.value })
          .from(suppressions)
          .where(
            and(
              eq(suppressions.workspace_id, workspaceId),
              inArray(suppressions.value, [
                email,
                data.email,
                data.person_id,
                hashSuppressionValue(email),
              ]),
            ),
          );
        const values = rows.map((row) => row.value);
        return outcome(
          !person && values.length > 0 && values.every((value) => value.startsWith(HASH_PREFIX)),
          `person ${person ? "still there" : "gone"}, blocks: ${values.join(", ") || "none"}`,
        );
      },
    ),
    check("the privacy problem is resolved", async ({ db, data }) => {
      const [row] = await db
        .select({ status: problems.status })
        .from(problems)
        .where(eq(problems.id, data.problem_id));
      return outcome(row?.status === "resolved", `problem status ${row?.status ?? "missing"}`);
    }),
    check("told the human what to send and by when", ({ finalText, data }) =>
      outcome(
        mentionsAny(finalText, deadlineForms(data)) &&
          mentionsAny(finalText, ["yourself", "your own", "you need to", "you have to"]) &&
          mentionsAny(finalText, ["send", "reply", "confirm"]),
        `expected the deadline (${data.due_plain}) and what the human must send themselves`,
      ),
    ),
  ],
});
