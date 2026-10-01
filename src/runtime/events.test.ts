import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../core/errors.js";
import { type EmittedEvent, onEvent } from "../core/events.js";
import type { EngineModule } from "../core/operation.js";
import {
  events,
  jobs,
  notification_channels,
  type Workspace,
  webhook_deliveries,
  workspaces,
} from "../db/schema/index.js";
import { module as system } from "../modules/system/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import type { FakeRequest } from "../testing/fake-fetch.js";
import { parseJobError } from "./jobs/runner.js";
import {
  isPublicUrl,
  notify,
  publicLink,
  renderEventNotification,
  slackPayload,
} from "./notify.js";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_SIGNATURE_HEADER,
} from "./webhooks.js";

const sendSystemEmail = vi.hoisted(() => vi.fn(async (_ctx: unknown, _input: unknown) => {}));
vi.mock("../modules/email/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/email/service.js")>()),
  sendSystemEmail,
}));

const seen: EmittedEvent<"campaign.launched">[] = [];
const listener: EngineModule = {
  name: "listener",
  eventHandlers: [
    onEvent("campaign.launched", "listener.on_launch", async (_ctx, event) => {
      seen.push(event);
    }),
  ],
};

let engine: TestEngine;
let workspace: Workspace;
const received: FakeRequest[] = [];
let hookStatus = 200;

const header = (request: FakeRequest | undefined, name: string) =>
  new Headers(request?.init?.headers as ConstructorParameters<typeof Headers>[0]).get(name);
const bodyOf = (request: FakeRequest | undefined) => String(request?.init?.body ?? "");
const nowSeconds = () => Math.floor(engine.clock.now().getTime() / 1000);

const launch = async (name = "Q4 dental clinics") => {
  const ctx = await engine.systemContext(workspace.id);
  return ctx.events.emit("campaign.launched", {
    subject: { type: "campaign", id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" },
    data: { campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9", name },
  });
};

beforeAll(async () => {
  engine = await createTestEngine({ modules: [system, listener] });
  const [row] = await engine.db
    .insert(workspaces)
    .values({ slug: "acme", name: "Acme" })
    .returning();
  if (!row) throw new Error("no workspace");
  workspace = row;
  engine.fetch.route(
    /^https:\/\/hooks\.example\.com\//,
    (request) => {
      received.push(request);
      return { status: hookStatus, body: hookStatus === 200 ? "ok" : "nope" };
    },
    "POST",
  );
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  seen.length = 0;
  received.length = 0;
  hookStatus = 200;
  sendSystemEmail.mockClear();
  await engine.db.delete(jobs);
  await engine.db.delete(events);
  await engine.db.delete(notification_channels);
  await engine.call("webhooks.list", {}, { workspace: "acme" }).then(async (page) => {
    for (const item of (page as { items: Array<{ id: string }> }).items) {
      await engine.call("webhooks.delete", { webhook_id: item.id }, { workspace: "acme" });
    }
  });
});

describe("event bus", () => {
  it("stores the event and runs each subscribed handler as a job", async () => {
    const { id } = await launch();
    const [row] = await engine.db.select().from(events).where(eq(events.id, id));
    expect(row).toMatchObject({
      workspace_id: workspace.id,
      type: "campaign.launched",
      subject_type: "campaign",
      data: { name: "Q4 dental clinics" },
    });
    const queued = await engine.db
      .select()
      .from(jobs)
      .where(eq(jobs.name, "event:listener.on_launch"));
    expect(queued).toHaveLength(1);

    await engine.runJobs();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id,
      type: "campaign.launched",
      workspaceId: workspace.id,
      subject: { type: "campaign", id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" },
      data: { name: "Q4 dental clinics" },
    });
    expect(seen[0]?.occurredAt).toEqual(engine.clock.now());
  });

  it("rejects unknown types and events without a workspace", async () => {
    const ctx = await engine.systemContext(null);
    await expect(
      ctx.events.emit("campaign.launched", { data: { campaign_id: "cmp_x", name: "x" } }),
    ).rejects.toThrowError(/without a workspace/);
    await expect(
      ctx.events.emit("nope.never" as "campaign.launched", {
        workspaceId: workspace.id,
        data: { campaign_id: "cmp_x", name: "x" },
      }),
    ).rejects.toBeInstanceOf(OpenOutboundError);
  });
});

describe("outgoing webhooks", () => {
  it("delivers signed events to subscribed endpoints only", async () => {
    const hook = (await engine.call(
      "webhooks.create",
      { url: "https://hooks.example.com/crm", events: ["campaign.launched"] },
      { workspace: "acme" },
    )) as { id: string; secret: string };
    expect(hook.secret).toMatch(/^whsec_/);
    await engine.call(
      "webhooks.create",
      { url: "https://hooks.example.com/other", events: ["reply.received"] },
      { workspace: "acme" },
    );
    const all = (await engine.call(
      "webhooks.create",
      { url: "https://hooks.example.com/all", events: ["*", "reply.received"] },
      { workspace: "acme" },
    )) as { events: string[] };
    expect(all.events).toEqual(["*"]);

    const { id } = await launch();
    await engine.runJobs();
    expect(received.map((request) => request.url).sort()).toEqual([
      "https://hooks.example.com/all",
      "https://hooks.example.com/crm",
    ]);
    const delivery = received.find((request) => request.url.endsWith("/crm"));
    const body = bodyOf(delivery);
    expect(JSON.parse(body)).toEqual({
      id,
      type: "campaign.launched",
      occurred_at: engine.clock.now().toISOString(),
      workspace_id: workspace.id,
      subject: { type: "campaign", id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" },
      data: { campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9", name: "Q4 dental clinics" },
    });
    expect(header(delivery, "OpenOutbound-Event")).toBe("campaign.launched");
    const signature = header(delivery, WEBHOOK_SIGNATURE_HEADER);
    expect(verifyWebhookSignature(hook.secret, signature, body, { nowSeconds: nowSeconds() })).toBe(
      true,
    );
    expect(
      verifyWebhookSignature("whsec_wrong", signature, body, { nowSeconds: nowSeconds() }),
    ).toBe(false);

    const rows = await engine.db.select().from(webhook_deliveries);
    expect(rows.every((row) => row.status === "delivered" && row.attempts === 1)).toBe(true);
    const detailed = (await engine.call(
      "webhooks.list",
      {},
      { workspace: "acme", responseFormat: "detailed" },
    )) as { items: Array<{ id: string; deliveries?: { delivered: number } }> };
    expect(detailed.items.find((item) => item.id === hook.id)?.deliveries?.delivered).toBe(1);
  });

  it("parks failed deliveries on the retry schedule and fails after the last attempt", async () => {
    await engine.call(
      "webhooks.create",
      { url: "https://hooks.example.com/flaky", events: ["campaign.launched"] },
      { workspace: "acme" },
    );
    hookStatus = 503;
    await launch();
    await engine.runJobs();
    const [first] = await engine.db.select().from(webhook_deliveries);
    expect(first).toMatchObject({ status: "pending", attempts: 1, response_status: 503 });
    expect(first?.next_attempt_at?.getTime()).toBe(
      engine.clock.now().getTime() + WEBHOOK_RETRY_DELAYS_MS[0],
    );
    const [parked] = await engine.db.select().from(jobs).where(eq(jobs.name, "webhooks.deliver"));
    expect(parked).toMatchObject({ status: "waiting", attempts: 0 });

    engine.advance(30_000);
    await engine.runJobs();
    expect(received).toHaveLength(1);

    for (const delay of WEBHOOK_RETRY_DELAYS_MS) {
      engine.advance(delay);
      await engine.runJobs();
    }
    expect(received).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    const [last] = await engine.db.select().from(webhook_deliveries);
    expect(last).toMatchObject({
      status: "failed",
      attempts: WEBHOOK_MAX_ATTEMPTS,
      last_error: "HTTP 503",
    });
    const [job] = await engine.db.select().from(jobs).where(eq(jobs.name, "webhooks.deliver"));
    expect(job?.status).toBe("succeeded");
  });

  it("recovers when the receiver comes back", async () => {
    await engine.call(
      "webhooks.create",
      { url: "https://hooks.example.com/recovering", events: ["campaign.launched"] },
      { workspace: "acme" },
    );
    hookStatus = 500;
    await launch();
    await engine.runJobs();
    hookStatus = 200;
    engine.advance(WEBHOOK_RETRY_DELAYS_MS[0]);
    await engine.runJobs();
    const [row] = await engine.db.select().from(webhook_deliveries);
    expect(row).toMatchObject({ status: "delivered", attempts: 2, last_error: null });
  });

  it("validates endpoint URLs and sends test deliveries", async () => {
    for (const url of [
      "http://hooks.example.com/x",
      "https://localhost/x",
      "https://10.0.0.8/x",
      "https://user:pass@hooks.example.com/x",
    ]) {
      await expect(
        engine.call("webhooks.create", { url, events: ["*"] }, { workspace: "acme" }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
    const hook = (await engine.call(
      "webhooks.create",
      { url: "https://hooks.example.com/test", events: ["*"] },
      { workspace: "acme" },
    )) as { id: string; secret: string };
    const result = await engine.call(
      "webhooks.test",
      { webhook_id: hook.id },
      { workspace: "acme" },
    );
    expect(result).toMatchObject({ ok: true, status: 200, error: null });
    const body = bodyOf(received[0]);
    expect(JSON.parse(body)).toMatchObject({ type: "webhook.test", workspace_id: workspace.id });
    expect(
      verifyWebhookSignature(hook.secret, header(received[0], WEBHOOK_SIGNATURE_HEADER), body, {
        nowSeconds: nowSeconds(),
      }),
    ).toBe(true);
    const listed = (await engine.call("webhooks.list", {}, { workspace: "acme" })) as {
      items: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(listed)).not.toContain(hook.secret);
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test_secret_for_signatures";
  const body = JSON.stringify({ id: "evt_1", type: "reply.received" });

  it("round-trips and rejects tampering, stale timestamps and junk", () => {
    const header = signWebhookPayload(secret, body, 1_790_000_000);
    expect(header).toMatch(/^t=1790000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: 1_790_000_100 })).toBe(true);
    expect(verifyWebhookSignature(secret, header, `${body} `, { nowSeconds: 1_790_000_100 })).toBe(
      false,
    );
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: 1_790_000_400 })).toBe(false);
    expect(
      verifyWebhookSignature(secret, header, body, {
        nowSeconds: 1_790_000_400,
        toleranceSeconds: 600,
      }),
    ).toBe(true);
    for (const junk of [null, "", "v1=abc", "t=abc,v1=def", "t=1790000000"]) {
      expect(verifyWebhookSignature(secret, junk, body, { nowSeconds: 1_790_000_000 })).toBe(false);
    }
  });

  it("accepts any matching v1 value (secret rotation)", () => {
    const valid = signWebhookPayload(secret, body, 1_790_000_000);
    const other = signWebhookPayload("whsec_old", body, 1_790_000_000).split(",")[1];
    const combined = `${valid.split(",")[0]},${other},${valid.split(",")[1]}`;
    expect(verifyWebhookSignature(secret, combined, body, { nowSeconds: 1_790_000_000 })).toBe(
      true,
    );
  });
});

describe("notifications", () => {
  const createChannel = async (input: Record<string, unknown>) =>
    (await engine.call("notifications.create", input, { workspace: "acme" })) as {
      id: string;
      secret: string | null;
      config: Record<string, unknown>;
    };

  it("routes curated notices, event notices and exact channel ids without duplicates", async () => {
    const slack = await createChannel({
      type: "slack_webhook",
      name: "Sales alerts",
      url: "https://hooks.example.com/slack/T000/B000",
    });
    expect(slack.config).toEqual({ url_host: "hooks.example.com" });
    const signed = await createChannel({
      type: "webhook",
      name: "Ops webhook",
      url: "https://hooks.example.com/notify",
      events: ["campaign.launched"],
    });
    expect(signed.secret).toMatch(/^whsec_/);
    await createChannel({
      type: "email",
      name: "Team inbox",
      to: ["Team@Example.com"],
      events: ["*"],
    });

    const ctx = await engine.systemContext(workspace.id);
    await notify(ctx, {
      title: "Hot reply from Dana <Harbor & Co>",
      lines: ["Wants a call next week"],
      url: "/v1/threads/thr_1",
      severity: "warning",
    });
    await engine.runJobs();
    expect(received.map((request) => request.url)).toEqual([
      "https://hooks.example.com/slack/T000/B000",
    ]);
    const slackBody = JSON.parse(bodyOf(received[0])) as {
      text: string;
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(slackBody.text).toBe(":warning: Hot reply from Dana <Harbor & Co>");
    expect(slackBody.blocks).toHaveLength(1);
    expect(slackBody.blocks[0]?.text?.text).toContain(
      "*Hot reply from Dana &lt;Harbor &amp; Co&gt;*",
    );
    expect(sendSystemEmail).not.toHaveBeenCalled();

    received.length = 0;
    await launch("Spring launch");
    await engine.runJobs();
    expect(received.map((request) => request.url)).toEqual(["https://hooks.example.com/notify"]);
    const eventBody = bodyOf(received[0]);
    expect(JSON.parse(eventBody)).toMatchObject({
      type: "notification",
      title: "Campaign launched",
      lines: ["campaign_id: cmp_01k6a3v0q8x3m2n4p5r6s7t8v9", "name: Spring launch"],
      event: "campaign.launched",
      url: null,
    });
    expect(
      verifyWebhookSignature(
        signed.secret ?? "",
        header(received[0], WEBHOOK_SIGNATURE_HEADER),
        eventBody,
        {
          nowSeconds: nowSeconds(),
        },
      ),
    ).toBe(true);
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
    expect(sendSystemEmail.mock.calls[0]?.[1]).toMatchObject({
      to: ["team@example.com"],
      subject: "Campaign launched",
      mailboxId: null,
    });

    received.length = 0;
    await notify(ctx, { title: "Weekly report", channelIds: [signed.id] });
    await notify(ctx, { title: "Nobody", channelIds: [] });
    await engine.runJobs();
    expect(received.map((request) => request.url)).toEqual(["https://hooks.example.com/notify"]);
    expect(JSON.parse(bodyOf(received[0]))).toMatchObject({ title: "Weekly report", event: null });
  });

  it("skips disabled channels, retries failures and never throws", async () => {
    const slack = await createChannel({
      type: "slack_webhook",
      name: "Alerts",
      url: "https://hooks.example.com/slack/alerts",
    });
    const ctx = await engine.systemContext(workspace.id);
    hookStatus = 500;
    await notify(ctx, { title: "Mailbox paused" });
    await engine.runJobs();
    const [job] = await engine.db.select().from(jobs).where(eq(jobs.name, "notifications.deliver"));
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    expect(parseJobError(job?.last_error ?? null)).toMatchObject({ code: "provider_error" });

    await engine.db
      .update(notification_channels)
      .set({ enabled: false })
      .where(eq(notification_channels.id, slack.id));
    engine.advance(10 * 60_000);
    await engine.runJobs();
    const [skipped] = await engine.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.name, "notifications.deliver"), eq(jobs.id, job?.id ?? "")));
    expect(skipped).toMatchObject({ status: "succeeded", result: { skipped: "disabled" } });

    await notify(ctx, { title: "Disabled channels get nothing" });
    const queued = await engine.db.select().from(jobs).where(eq(jobs.status, "queued"));
    expect(queued).toHaveLength(0);
    const orphan = await engine.systemContext(null);
    await expect(notify(orphan, { title: "No workspace" })).resolves.toBeUndefined();
  });

  it("tests channels on demand", async () => {
    const slack = await createChannel({
      type: "slack_webhook",
      name: "Alerts",
      url: "https://hooks.example.com/slack/test",
    });
    await expect(
      engine.call("notifications.test", { channel_id: slack.id }, { workspace: "acme" }),
    ).resolves.toMatchObject({ ok: true, status: 200 });
    hookStatus = 404;
    await expect(
      engine.call("notifications.test", { channel_id: slack.id }, { workspace: "acme" }),
    ).resolves.toMatchObject({ ok: false, status: 404, error: "Slack answered 404 (nope)" });
    await expect(
      engine.call("notifications.create", { type: "email", name: "No one" }, { workspace: "acme" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    const listed = JSON.stringify(
      await engine.call("notifications.list", {}, { workspace: "acme" }),
    );
    expect(listed).not.toContain("/slack/test");
  });

  it("renders compact event messages and public links only", () => {
    const message = renderEventNotification("mailbox.paused", {
      mailbox_id: "mbx_1",
      email: "sam@example.com",
      reason: "bounce rate",
      nested: { skipped: true },
    });
    expect(message).toEqual({
      title: "Mailbox paused",
      lines: ["mailbox_id: mbx_1", "email: sam@example.com", "reason: bounce rate"],
      url: null,
      severity: "warning",
      event: "mailbox.paused",
    });
    expect(renderEventNotification("linkedin.account_restricted", {}).severity).toBe("critical");
    expect(
      slackPayload({ ...message, severity: "info" }, "https://oo.example.com/t/1").blocks,
    ).toHaveLength(2);

    expect(isPublicUrl("https://oo.example.com/x")).toBe(true);
    for (const local of [
      "http://localhost:7331/x",
      "http://10.1.2.3/x",
      "http://[::1]:7331/x",
      "http://openoutbound/x",
      "http://oo.internal/x",
      "not a url",
    ]) {
      expect(isPublicUrl(local)).toBe(false);
    }
    expect(publicLink("https://oo.example.com", "/v1/threads/thr_1")).toBe(
      "https://oo.example.com/v1/threads/thr_1",
    );
    expect(publicLink("http://localhost:7331", "/v1/threads/thr_1")).toBeNull();
    expect(publicLink("http://localhost:7331", null)).toBeNull();
  });
});
