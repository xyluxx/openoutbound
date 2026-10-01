/**
 * Launch before the brain. A campaign whose emails are written by AI is launched in a workspace
 * with no AI brain configured. Its first email waits instead of failing: the writing job parks
 * on the workspace's brain key without using an attempt, days pass and nothing fails or goes
 * out, and the workspace says why (brain_down for provider "none"). Configuring a brain (here
 * the connected agent) wakes the job at once: the email is written, checked and sent.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { jobs } from "../../../src/db/schema/index.js";
import { getSandboxOutbox } from "../../../src/modules/email/sandbox-transport.js";
import {
  type Any,
  advance,
  campaignEmail,
  createCampaign,
  DAY,
  enrollAndLaunch,
  messagesOf,
  PASSING_CHECK,
  problemsOf,
  startWorld,
  until,
  type World,
} from "./support.js";

let world: World;
afterAll(async () => {
  await world?.close();
});

async function writingJobs() {
  return world.engine.db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.workspace_id, world.workspaceId), eq(jobs.name, "campaigns.generate_message")),
    );
}

/** The connected agent answers every open brain task the scenario reaches. */
async function answerTasks(): Promise<void> {
  const tasks = await world.call<Any>("agent_tasks.list", {});
  for (const task of tasks.items) {
    let output: unknown;
    if (task.prompt_id === "campaign.email.write") {
      output = campaignEmail({ prospect: "Name: Eli Moss", first_touch: true });
    } else if (task.prompt_id === "campaign.email.check") {
      output = PASSING_CHECK;
    } else {
      throw new Error(`The scenario did not expect a task for ${task.prompt_id}`);
    }
    await world.call("agent_tasks.submit", { task_id: task.id, output });
  }
}

describe("acceptance: launch before the brain", () => {
  it("waits for a brain instead of failing, then writes and sends the email", async () => {
    world = await startWorld({ brain: false });
    const eli = await world.lead({
      person: {
        first_name: "Eli",
        last_name: "Moss",
        full_name: "Eli Moss",
        email: "eli@moss-dental.example.com",
      },
      company: { name: "Moss Dental", domain: "moss-dental.example.com" },
    });
    const campaign = await createCampaign(world, { name: "Written by AI" });
    await enrollAndLaunch(world, campaign.id, [eli.person.id]);

    // The writing job parks on the workspace's brain key, using no attempt.
    await until(world.engine, "the writing job waits for a brain", async () =>
      (await writingJobs()).some((job) => job.status === "waiting"),
    );
    const waitKey = `brain:configured:${world.workspaceId}`;
    expect(await writingJobs()).toMatchObject([
      { status: "waiting", wait_for: waitKey, attempts: 0, last_error: null },
    ]);

    // Days pass: it keeps waiting (checking once an hour), nothing failed, nothing went out.
    for (let day = 0; day < 2; day += 1) await advance(world.engine, DAY);
    expect(await writingJobs()).toMatchObject([
      { status: "waiting", wait_for: waitKey, attempts: 0 },
    ]);
    const [waiting] = await messagesOf(world, { personId: eli.person.id, direction: "outbound" });
    expect(waiting?.status).toBe("generating");
    expect(getSandboxOutbox({ workspaceId: world.workspaceId })).toHaveLength(0);
    expect(await problemsOf(world, "brain_down")).toMatchObject([
      { status: "open", dedupe_key: "brain_down:none" },
    ]);

    // A brain is configured: the job wakes at once.
    await world.call("providers.set", { slot: "brain", provider: "agent" });
    expect(await writingJobs()).toMatchObject([{ status: "queued", wait_for: null }]);

    // The email is written (by the connected agent), checked and sent.
    await until(world.engine, "the email is sent", async () => {
      await answerTasks();
      const rows = await messagesOf(world, { personId: eli.person.id, direction: "outbound" });
      return rows.some((row) => row.status === "sent");
    });
    const [sent] = await messagesOf(world, { personId: eli.person.id, direction: "outbound" });
    expect(sent).toMatchObject({ status: "sent", subject: "front desk coverage" });
    expect(sent?.body_text).toContain("Hi Eli");
    expect(getSandboxOutbox({ workspaceId: world.workspaceId })).toHaveLength(1);
    expect((await writingJobs()).every((job) => job.status === "succeeded")).toBe(true);
  });
});
