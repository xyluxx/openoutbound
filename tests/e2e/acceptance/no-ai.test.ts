/**
 * Acceptance scenario 8, no AI. A client workspace runs with no AI brain configured at all. Its
 * schedules still run: exact-template emails go out on time, while an email that needs AI
 * writing is never sent. Replies still come in and are stored, and the deterministic prechecks
 * still act without a model: an unsubscribe phrase unsubscribes, a privacy phrase opens the
 * urgent privacy problem, and a bounce marks the address. A reply that needs the model waits for
 * a person (the thread needs attention and the sequence pauses) instead of crashing, and the
 * jobs that need the model wait for a brain instead of failing. Reports and tasks work, and the
 * operating state, the problems list and the attention queue say why: no AI brain is
 * configured, with the fix.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { BRAIN_DOWN_REMEDY } from "../../../src/brain/fallback.js";
import { jobs, people, suppressions, threads } from "../../../src/db/schema/index.js";
import { getSandboxOutbox } from "../../../src/modules/email/sandbox-transport.js";
import { ingestInboundEmail } from "../../../src/modules/email/service.js";
import {
  type Any,
  advance,
  createCampaign,
  DAY,
  enrollAndLaunch,
  enrollmentsOf,
  type Lead,
  messagesOf,
  problemsOf,
  receiveReply,
  settle,
  startWorld,
  until,
  type World,
} from "./support.js";

let world: World;
afterAll(async () => {
  await world?.close();
});

async function personRow(id: string) {
  const [row] = await world.engine.db.select().from(people).where(eq(people.id, id));
  return row;
}

async function firstSent(lead: Lead) {
  const rows = await messagesOf(world, { personId: lead.person.id, direction: "outbound" });
  return rows.find((row) => row.status === "sent");
}

describe("acceptance: no AI", () => {
  it("keeps the rule-based work running and says why the AI work waits", async () => {
    world = await startWorld({ brain: false });
    const leads: Lead[] = [];
    for (const [first, last, slug] of [
      ["Ada", "Stone", "stone-dental"],
      ["Ben", "Hart", "hart-dental"],
      ["Cleo", "Park", "park-dental"],
      ["Dev", "Rao", "rao-dental"],
      ["Eli", "Moss", "moss-dental"],
    ] as const) {
      leads.push(
        await world.lead({
          person: {
            first_name: first,
            last_name: last,
            full_name: `${first} ${last}`,
            email: `${first.toLowerCase()}@${slug}.example.com`,
          },
          company: { name: `${last} Dental`, domain: `${slug}.example.com` },
        }),
      );
    }
    const [ada, ben, cleo, dev, eli] = leads as [Lead, Lead, Lead, Lead, Lead];
    const exact = await createCampaign(world, {
      name: "Exact template",
      steps: [
        {
          type: "email",
          config: {
            style: "exact",
            subject: "front desk coverage",
            body: "Hi {{first_name}}, we answer overflow calls for dental groups so patients never hit voicemail. Would that help your front desk?",
          },
        },
        { type: "email", delay_days: 3, config: { mode: "reply", style: "free" } },
      ],
    });
    const written = await createCampaign(world, { name: "Written by AI" });
    await enrollAndLaunch(
      world,
      exact.id,
      [ada, ben, cleo, dev].map((lead) => lead.person.id),
    );
    await enrollAndLaunch(world, written.id, [eli.person.id]);

    // Schedules run: the exact-template emails go out.
    await until(world.engine, "the template emails are sent", async () => {
      const sent = await Promise.all([ada, ben, cleo, dev].map(firstSent));
      return sent.every(Boolean);
    });
    const firsts = await Promise.all([ada, ben, cleo, dev].map(firstSent));
    expect(getSandboxOutbox({ workspaceId: world.workspaceId })).toHaveLength(4);

    // Replies come in; the prechecks act without a model.
    const [toAda, toBen, toCleo, toDev] = firsts as [Any, Any, Any, Any];
    const adaReply = await receiveReply(world, toAda, "Thanks, tell me more about the pricing.");
    await receiveReply(world, toBen, "Please unsubscribe me from this list.");
    await receiveReply(world, toCleo, "Please delete all the data you hold about me.");
    await ingestInboundEmail(await world.context(), {
      mailboxId: world.mailbox.id,
      from: "MAILER-DAEMON@mx.rao-dental.example.com",
      to: [world.mailbox.email],
      subject: "Undelivered Mail Returned to Sender",
      text: [
        "Final-Recipient: rfc822; dev@rao-dental.example.com",
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 <dev@rao-dental.example.com>: Recipient address rejected: User unknown",
        "",
        `Original-Message-ID: ${toDev.message_id_header}`,
      ].join("\n"),
      headers: {},
      messageIdHeader: "<dsn-1@mx.rao-dental.example.com>",
      receivedAt: world.engine.clock.now(),
    });
    await settle(world.engine);

    // Unsubscribe phrase: unsubscribed and blocked.
    expect((await personRow(ben.person.id))?.status).toBe("unsubscribed");
    expect(await enrollmentsOf(world, ben.person.id)).toMatchObject([
      { status: "stopped", stop_reason: "unsubscribed" },
    ]);
    // Privacy phrase: do not contact, the urgent privacy problem.
    expect((await personRow(cleo.person.id))?.status).toBe("do_not_contact");
    expect(await problemsOf(world, "privacy_request")).toMatchObject([
      { severity: "urgent", status: "open", person_id: cleo.person.id },
    ]);
    // Bounce: the email bounced, the address is marked and the sequence stopped.
    const [bounced] = await messagesOf(world, { personId: dev.person.id, direction: "outbound" });
    expect(bounced).toMatchObject({ id: toDev.id, status: "bounced" });
    expect((await personRow(dev.person.id))?.status).toBe("bounced");
    expect(await enrollmentsOf(world, dev.person.id)).toMatchObject([
      { status: "stopped", stop_reason: "bounced" },
    ]);
    const blocked = await world.engine.db
      .select({ type: suppressions.type, value: suppressions.value })
      .from(suppressions)
      .where(eq(suppressions.workspace_id, world.workspaceId));
    expect(blocked).toEqual(
      expect.arrayContaining([
        { type: "email", value: "ben@hart-dental.example.com" },
        { type: "email", value: "cleo@park-dental.example.com" },
        { type: "email", value: "dev@rao-dental.example.com" },
      ]),
    );

    // A reply that needs the model is stored and waits for a person; nothing crashed.
    const [adaInbound] = await messagesOf(world, {
      personId: ada.person.id,
      direction: "inbound",
    });
    expect(adaInbound).toMatchObject({ id: adaReply.messageId, status: "received" });
    expect(adaInbound?.classification).toBeNull();
    const [adaThread] = await world.engine.db
      .select()
      .from(threads)
      .where(eq(threads.id, adaReply.threadId ?? ""));
    expect(adaThread?.needs_attention).toBe(true);
    expect(await enrollmentsOf(world, ada.person.id)).toMatchObject([
      { status: "paused", stop_reason: "reply_pending_classification" },
    ]);
    const classify = await world.engine.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspace_id, world.workspaceId), eq(jobs.name, "inbox.classify")));
    const adaJob = classify.find(
      (row) => (row.payload as { message_id?: string }).message_id === adaReply.messageId,
    );
    // The classification waits for a brain, using no attempt, instead of failing.
    expect(adaJob).toMatchObject({
      status: "waiting",
      wait_for: `brain:configured:${world.workspaceId}`,
      attempts: 0,
    });

    // The workspace says why, with the fix.
    const [brainProblem] = await problemsOf(world, "brain_down");
    expect(brainProblem).toMatchObject({
      status: "open",
      severity: "high",
      owner: "person",
      title: "No AI brain is configured",
      remedy: BRAIN_DOWN_REMEDY,
      dedupe_key: "brain_down:none",
    });
    expect(brainProblem?.reason).toContain("manage_providers (action set, slot brain)");
    const state = await world.call<Any>("operating.state");
    expect(state.brain).toEqual({ provider: null, healthy: false, problem_id: brainProblem?.id });
    expect(state.problems.top).toContainEqual(
      expect.objectContaining({ id: brainProblem?.id, kind: "brain_down" }),
    );
    const attention = await world.call<Any>("attention.get", {});
    expect(attention.warnings).toContainEqual(
      expect.objectContaining({
        code: "provider_missing",
        severity: "critical",
        hint: expect.stringContaining("manage_providers (action set, slot brain)"),
      }),
    );

    // Reports and tasks work.
    const report = await world.call<Any>("reports.get", {
      type: "overview",
      period: "last_7_days",
    });
    expect(report.type).toBe("overview");
    const task = await world.call<Any>("tasks.create", {
      title: "Call Ada Stone about pricing",
      person_id: ada.person.id,
    });
    expect(task.status).toBe("open");
    const listed = await world.call<Any>("tasks.list", {});
    expect(listed.items.map((item: Any) => item.id)).toContain(task.id);
    const done = await world.call<Any>("tasks.complete", { task_id: task.id });
    expect(done.status).toBe("done");

    // Days later nothing that needs AI writing went out.
    for (let day = 0; day < 4; day += 1) await advance(world.engine, DAY);
    expect(getSandboxOutbox({ workspaceId: world.workspaceId })).toHaveLength(4);
    const eliMessages = await messagesOf(world, { personId: eli.person.id, direction: "outbound" });
    expect(eliMessages.filter((row) => row.status === "sent")).toEqual([]);
    const jobRows = await world.engine.db
      .select({ name: jobs.name, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.workspace_id, world.workspaceId));
    // Every schedule ran and nothing failed: the two jobs that need the model wait for a brain.
    const failed = new Set(jobRows.filter((row) => row.status === "failed").map((row) => row.name));
    expect([...failed]).toEqual([]);
    const waiting = new Set(
      jobRows.filter((row) => row.status === "waiting").map((row) => row.name),
    );
    expect([...waiting].sort()).toEqual(["campaigns.generate_message", "inbox.classify"]);
    const ran = new Set(jobRows.filter((row) => row.status === "succeeded").map((row) => row.name));
    for (const name of [
      "campaigns.tick",
      "email.send",
      "email.reconcile_sends",
      "inbox.privacy_reminders",
      "meetings.assume_held",
      "relationships.stuck_check",
      "leads.retention_sweep",
    ]) {
      expect(ran).toContain(name);
    }
  });
});
