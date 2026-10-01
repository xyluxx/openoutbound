/**
 * Notification channel health: every delivery failure is counted with its class, a channel that
 * fails 5 times in a row is marked failing with a problem naming the fix, failures retrying
 * cannot fix are not retried, and any success (a delivery or a test) clears it.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  jobs,
  notification_channels,
  problems,
  type Workspace,
  workspaces,
} from "../db/schema/index.js";
import { module as system } from "../modules/system/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import {
  FAILING_AFTER,
  failingKey,
  recordChannelFailure,
  recordChannelSuccess,
} from "./channel-health.js";
import { parseJobError } from "./jobs/runner.js";
import { notify } from "./notify.js";

let engine: TestEngine;
let workspace: Workspace;
let hookStatus = 200;

beforeAll(async () => {
  engine = await createTestEngine({ modules: [system] });
  const [row] = await engine.db
    .insert(workspaces)
    .values({ slug: "acme", name: "Acme" })
    .returning();
  if (!row) throw new Error("no workspace");
  workspace = row;
  engine.fetch.route(
    /^https:\/\/hooks\.example\.com\//,
    () => ({
      status: hookStatus,
      body: hookStatus === 200 ? "ok" : "nope",
      ...(hookStatus === 429 ? { headers: { "retry-after": "120" } } : {}),
    }),
    "POST",
  );
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  hookStatus = 200;
  await engine.db.delete(jobs);
  await engine.db.delete(problems);
  await engine.db.delete(notification_channels);
});

async function slackChannel() {
  return (await engine.call(
    "notifications.create",
    { type: "slack_webhook", name: "Alerts", url: "https://hooks.example.com/slack/alerts" },
    { workspace: "acme" },
  )) as { id: string };
}

async function channelRow(id: string) {
  const [row] = await engine.db
    .select()
    .from(notification_channels)
    .where(eq(notification_channels.id, id));
  if (!row) throw new Error("channel gone");
  return row;
}

async function failingProblems(id: string) {
  return engine.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, workspace.id), eq(problems.dedupe_key, failingKey(id))));
}

async function listed(id: string) {
  const page = (await engine.call("notifications.list", {}, { workspace: "acme" })) as {
    items: Array<Record<string, unknown>>;
  };
  return page.items.find((item) => item.id === id);
}

describe("notification channel health", () => {
  it("does not retry a delivery that cannot work, and marks the channel failing after 5 in a row", async () => {
    const channel = await slackChannel();
    const ctx = await engine.systemContext(workspace.id);
    hookStatus = 404;
    for (let n = 1; n <= FAILING_AFTER; n++) {
      await notify(ctx, { title: `Notice ${n}` });
      await engine.runJobs();
      if (n < FAILING_AFTER) expect(await failingProblems(channel.id)).toHaveLength(0);
    }

    const deliveries = await engine.db
      .select()
      .from(jobs)
      .where(eq(jobs.name, "notifications.deliver"));
    expect(deliveries.map((job) => [job.status, job.attempts])).toEqual(
      Array.from({ length: FAILING_AFTER }, () => ["failed", 1]),
    );
    const stored = parseJobError(deliveries[0]?.last_error ?? null);
    expect(stored).toMatchObject({
      code: "provider_error",
      message: 'Notification to "Alerts" failed: Slack answered 404 (nope)',
    });
    expect(stored?.hint).toContain("manage_notifications action test");

    expect((await channelRow(channel.id)).health).toMatchObject({
      consecutive_failures: FAILING_AFTER,
      failing_since: engine.clock.now().toISOString(),
      last_error: "Slack answered 404 (nope)",
      last_failure: { class: "not_found", retryable: false },
    });
    const [problem] = await failingProblems(channel.id);
    expect(problem).toMatchObject({
      kind: "custom",
      severity: "high",
      owner: "person",
      status: "open",
      subject_type: "notification_channel",
      subject_id: channel.id,
    });
    expect(problem?.remedy).toContain("manage_notifications");
    expect(await listed(channel.id)).toMatchObject({
      failing: true,
      consecutive_failures: FAILING_AFTER,
      last_error: "Slack answered 404 (nope)",
    });

    // One more failure refreshes the same problem.
    await notify(ctx, { title: "Again" });
    await engine.runJobs();
    expect(await failingProblems(channel.id)).toHaveLength(1);

    // A test that works clears it.
    hookStatus = 200;
    await expect(
      engine.call("notifications.test", { channel_id: channel.id }, { workspace: "acme" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await channelRow(channel.id)).health).toMatchObject({
      consecutive_failures: 0,
      failing_since: null,
      last_failure: null,
    });
    expect((await failingProblems(channel.id)).map((p) => p.status)).toEqual(["resolved"]);
    expect(await listed(channel.id)).toMatchObject({ failing: false, consecutive_failures: 0 });
  });

  it("retries a temporary failure and a later delivery resets the count", async () => {
    const channel = await slackChannel();
    const ctx = await engine.systemContext(workspace.id);
    hookStatus = 503;
    await notify(ctx, { title: "Mailbox paused" });
    await engine.runJobs();
    const [job] = await engine.db.select().from(jobs).where(eq(jobs.name, "notifications.deliver"));
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    expect((await channelRow(channel.id)).health).toMatchObject({
      consecutive_failures: 1,
      last_failure: { class: "unavailable", retryable: true },
      failing_since: null,
    });

    hookStatus = 200;
    engine.advance(10 * 60_000);
    await engine.runJobs();
    expect((await channelRow(channel.id)).health).toMatchObject({ consecutive_failures: 0 });
  });

  it("clears failures other deliveries counted after this one loaded the channel", async () => {
    const channel = await slackChannel();
    const ctx = await engine.systemContext(workspace.id);
    const failure = { class: "unavailable", retryable: true, scope: "provider" } as const;
    // A delivery loads the channel, then other deliveries fail while it is sending.
    const loaded = await channelRow(channel.id);
    for (let n = 0; n < FAILING_AFTER - 1; n++) {
      await recordChannelFailure(ctx, loaded, "HTTP 503", failure);
    }
    await recordChannelSuccess(ctx, loaded);
    expect((await channelRow(channel.id)).health).toMatchObject({
      consecutive_failures: 0,
      failing_since: null,
    });
    await recordChannelFailure(ctx, loaded, "HTTP 503", failure);
    expect((await channelRow(channel.id)).health).toMatchObject({ consecutive_failures: 1 });
    expect(await failingProblems(channel.id)).toEqual([]);

    // Marked failing after it loaded the channel: the success resolves the problem too.
    for (let n = 0; n < FAILING_AFTER; n++) {
      await recordChannelFailure(ctx, loaded, "HTTP 503", failure);
    }
    expect((await failingProblems(channel.id)).map((p) => p.status)).toEqual(["open"]);
    await recordChannelSuccess(ctx, loaded);
    expect((await channelRow(channel.id)).health).toMatchObject({
      consecutive_failures: 0,
      failing_since: null,
    });
    expect((await failingProblems(channel.id)).map((p) => p.status)).toEqual(["resolved"]);
  });

  it("waits as long as Slack asks after a rate limit", async () => {
    const channel = await slackChannel();
    const ctx = await engine.systemContext(workspace.id);
    hookStatus = 429;
    await notify(ctx, { title: "Busy" });
    await engine.runJobs();
    const [job] = await engine.db.select().from(jobs).where(eq(jobs.name, "notifications.deliver"));
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    expect(job?.run_at.getTime()).toBe(engine.clock.now().getTime() + 120_000);
    expect((await channelRow(channel.id)).health).toMatchObject({
      consecutive_failures: 1,
      last_failure: { class: "rate_limited", retryable: true, retry_after_s: 120 },
    });
  });

  it("closes the problem when the channel is deleted", async () => {
    const channel = await slackChannel();
    const ctx = await engine.systemContext(workspace.id);
    hookStatus = 410;
    for (let n = 0; n < FAILING_AFTER; n++) {
      await notify(ctx, { title: "Gone" });
      await engine.runJobs();
    }
    expect((await failingProblems(channel.id)).map((p) => p.status)).toEqual(["open"]);
    await engine.call("notifications.delete", { channel_id: channel.id }, { workspace: "acme" });
    expect((await failingProblems(channel.id)).map((p) => p.status)).toEqual(["resolved"]);
  });
});
