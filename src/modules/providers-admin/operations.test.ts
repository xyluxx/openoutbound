import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brainConfiguredWaitKey } from "../../brain/fallback.js";
import { jobs, type Workspace, workspaces } from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";

let engine: TestEngine;
let acme: Workspace;
let globex: Workspace;

beforeAll(async () => {
  engine = await createTestEngine();
  const rows = await engine.db
    .insert(workspaces)
    .values([
      { slug: "acme", name: "Acme" },
      { slug: "globex", name: "Globex" },
    ])
    .returning();
  [acme, globex] = rows as [Workspace, Workspace];
});
afterAll(async () => {
  await engine.close();
});

/** A writing job parked until its workspace has a brain, as the brain service leaves it. */
async function parked(workspace: Workspace): Promise<string> {
  const [row] = await engine.db
    .insert(jobs)
    .values({
      workspace_id: workspace.id,
      name: "campaigns.generate_message",
      payload: { message_id: "msg_waiting" },
      status: "waiting",
      wait_for: brainConfiguredWaitKey(workspace.id),
      run_at: new Date(engine.clock.now().getTime() + 60 * 60_000),
    })
    .returning({ id: jobs.id });
  return row?.id ?? "";
}

async function statusOf(jobId: string) {
  const [row] = await engine.db
    .select({ status: jobs.status, wait_for: jobs.wait_for })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  return row;
}

describe("providers.set for the brain", () => {
  it("wakes the jobs that wait for a brain: the workspace's, or every workspace's", async () => {
    const acmeJob = await parked(acme);
    const globexJob = await parked(globex);

    await engine.call(
      "providers.set",
      { slot: "brain", provider: "anthropic", secrets: { api_key: "test-anthropic-key-01" } },
      { workspace: "acme" },
    );
    expect(await statusOf(acmeJob)).toEqual({ status: "queued", wait_for: null });
    expect(await statusOf(globexJob)).toMatchObject({ status: "waiting" });

    // Another slot wakes nothing.
    await engine.call(
      "providers.set",
      { slot: "research", provider: "exa", secrets: { api_key: "test-exa-key-01" } },
      { workspace: "globex" },
    );
    expect(await statusOf(globexJob)).toMatchObject({ status: "waiting" });

    // An instance-wide brain serves every workspace.
    await engine.call("providers.set", {
      slot: "brain",
      provider: "anthropic",
      level: "instance",
      secrets: { api_key: "test-anthropic-key-02" },
    });
    expect(await statusOf(globexJob)).toEqual({ status: "queued", wait_for: null });
  });
});
