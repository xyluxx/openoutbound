/**
 * End to end on the real engine (createTestEngine): reports and the attention queue through the
 * executor with real principals and API keys, the MCP tool mapping, and a scheduled report from
 * the scheduler tick through `reports.run_schedule` and `notify` to `notifications.deliver`.
 * Clock: Saturday 2026-09-19 12:00 UTC.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../core/context.js";
import { approvals, events, reports, schedules } from "../../db/schema/index.js";
import { buildCatalog } from "../../mcp/catalog.js";
import { serveEmbeddedStdio } from "../../mcp/stdio.js";
import { buildToolSpecs, type McpToolSpec, prepareCall } from "../../mcp/tools.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { seedMessage, seedPerson } from "../../testing/factories.js";
import { createFakeBrain } from "../../testing/fake-brain.js";
import type { FakeRequest } from "../../testing/fake-fetch.js";
import { REPORT_JOB_NAME } from "./schedule-config.js";

const SLACK_URL = "https://hooks.example.com/services/T000/B000/XXXX";
const HOOK_URL = "https://hooks.example.org/openoutbound";
const OTHER_URL = "https://hooks.example.com/services/T000/B000/OTHER";
const SUMMARY = {
  summary: "4 people were contacted and 2 replied, a 50.0% reply rate, with 1 positive reply.",
  highlights: ["Reply rate 50.0%"],
};
const t = (iso: string) => new Date(iso);

interface WorkspaceView {
  id: string;
  slug: string;
  name: string;
}
interface KeyView {
  id: string;
  key: string;
}

let engine: TestEngine;
let harbor: WorkspaceView;
let cedar: WorkspaceView;
const keys: Record<string, Principal> = {};
const channels: Record<string, string> = {};

async function principalFor(input: Record<string, unknown>, workspace?: string) {
  const created = (await engine.call(
    "keys.create",
    input,
    workspace ? { workspace } : {},
  )) as KeyView;
  const principal = await engine.authenticate(created.key, "http");
  if (!principal) throw new Error("the new key does not authenticate");
  return principal;
}

async function seedOutreach(workspaceId: string, contacted: number, replied: number) {
  const target = { db: engine.db, workspace: { id: workspaceId } };
  for (let i = 0; i < contacted; i++) {
    const person = await seedPerson(target, { created_at: t("2026-09-01T00:00:00Z") });
    await seedMessage(target, {
      person_id: person.id,
      status: "sent",
      sent_at: t(`2026-09-1${5 + (i % 4)}T09:00:00Z`),
    });
    if (i < replied) {
      await seedMessage(target, {
        person_id: person.id,
        direction: "inbound",
        status: "received",
        action: "reply",
        received_at: t(`2026-09-1${5 + (i % 4)}T15:00:00Z`),
        classification: { category: i === 0 ? "interested" : "not_now", confidence: 0.9 },
      });
    }
  }
}

function toolSpecs(): Map<string, McpToolSpec> {
  const catalog = buildCatalog(engine.registry, "test");
  const built = buildToolSpecs(catalog, new Set(["core", "admin"]));
  const ours = ["get_report", "get_attention_queue", "manage_report_schedules"];
  expect(built.problems.filter((problem) => ours.some((name) => problem.includes(name)))).toEqual(
    [],
  );
  return new Map(built.specs.map((spec) => [spec.name, spec]));
}

/** What an MCP tool call does: map the arguments to one operation, then run it. */
async function callTool(
  spec: McpToolSpec | undefined,
  args: Record<string, unknown>,
  principal: Principal,
) {
  if (!spec) throw new Error("tool not registered");
  const prepared = prepareCall(spec, args, null);
  return engine.call(prepared.operation.id, prepared.input, { ...prepared.options, principal });
}

beforeAll(async () => {
  engine = await createTestEngine({
    brain: createFakeBrain({ handlers: { "reports.summary": SUMMARY } }),
    fetchRoutes: [
      { match: SLACK_URL, method: "POST", response: { status: 200, body: "ok" } },
      { match: HOOK_URL, method: "POST", response: { status: 204 } },
      { match: OTHER_URL, method: "POST", response: { status: 200, body: "ok" } },
    ],
  });
  harbor = (await engine.call("workspaces.create", {
    name: "Harbor Outreach",
    timezone: "Europe/Berlin",
  })) as WorkspaceView;
  await seedOutreach(harbor.id, 4, 2);
  keys.harborAgent = await principalFor({ name: "Harbor agent", kind: "agent" }, harbor.slug);
});

afterAll(async () => {
  await engine.close();
});

describe("get_report through the executor", () => {
  it("uses the only workspace for an instance principal that names none", async () => {
    const output = (await engine.call("reports.get", { type: "overview" })) as {
      workspace: { id: string } | null;
      period: { timezone: string };
      data: { metrics: { contacted: { value: number }; reply_rate: { value: number } } };
    };
    expect(output.workspace?.id).toBe(harbor.id);
    expect(output.period.timezone).toBe("Europe/Berlin");
    expect(output.data.metrics.contacted.value).toBe(4);
    expect(output.data.metrics.reply_rate.value).toBe(50);
  });

  it("serves a workspace key its own workspace in every format", async () => {
    const principal = keys.harborAgent as Principal;
    const markdown = (await engine.call(
      "reports.get",
      { type: "overview", format: "markdown" },
      { principal },
    )) as { markdown: string; data?: unknown };
    expect(markdown.markdown).toContain("## Overview: Harbor Outreach");
    expect(markdown.data).toBeUndefined();
    const csv = (await engine.call(
      "reports.get",
      { type: "campaign", format: "csv", workspace: harbor.slug },
      { principal },
    )) as { csv: string };
    expect(csv.csv.split("\r\n")[0]).toContain("campaign_id,campaign");
  });

  it("returns actionable input errors", async () => {
    await expect(
      engine.call("reports.get", { period: "today", from: "2026-09-01", to: "2026-09-02" }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining("last_7_days"),
    });
    await expect(engine.call("reports.get", { type: "weekly" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("agency scope over API keys", () => {
  beforeAll(async () => {
    cedar = (await engine.call("workspaces.create", { name: "Cedar Clinics" })) as WorkspaceView;
    await seedOutreach(cedar.id, 1, 0);
    keys.instanceAdmin = await principalFor({ name: "Agency owner", kind: "human" });
    keys.instanceAgent = await principalFor({ name: "Agency agent", kind: "agent" });
  });

  it("an instance key with the admin scope sees every workspace", async () => {
    const output = (await engine.call(
      "reports.get",
      { type: "agency" },
      { principal: keys.instanceAdmin as Principal },
    )) as {
      workspace: null;
      data: {
        workspaces: Array<{ name: string; metrics: { contacted: { value: number } } }>;
        totals: { contacted: { value: number } };
      };
    };
    expect(output.workspace).toBeNull();
    expect(output.data.workspaces.map((row) => [row.name, row.metrics.contacted.value])).toEqual([
      ["Cedar Clinics", 1],
      ["Harbor Outreach", 4],
    ]);
    expect(output.data.totals.contacted.value).toBe(5);
  });

  it("an instance key without admin is refused", async () => {
    await expect(
      engine.call(
        "reports.get",
        { type: "agency" },
        { principal: keys.instanceAgent as Principal },
      ),
    ).rejects.toMatchObject({ code: "forbidden", details: { missing_scope: "admin" } });
  });

  it("a workspace key is refused, even with the admin scope", async () => {
    const boundAdmin = await principalFor({ name: "Harbor owner", kind: "human" }, harbor.slug);
    await expect(
      engine.call("reports.get", { type: "agency" }, { principal: boundAdmin }),
    ).rejects.toMatchObject({
      code: "forbidden",
      hint: expect.stringContaining("instance-level API key"),
    });
    await expect(
      engine.call(
        "reports.get",
        { type: "overview" },
        { principal: keys.harborAgent as Principal, workspace: cedar.slug },
      ),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "workspace_scope" } });
  });

  it("asks which workspace once there are several", async () => {
    await expect(engine.call("reports.get", { type: "overview" })).rejects.toMatchObject({
      code: "validation_failed",
      hint: expect.stringContaining(harbor.slug),
    });
    const output = (await engine.call(
      "reports.get",
      { type: "overview" },
      { workspace: cedar.slug },
    )) as { workspace: { name: string } };
    expect(output.workspace.name).toBe("Cedar Clinics");
  });
});

describe("get_attention_queue through the executor", () => {
  it("reads the key's workspace with the real provider resolver", async () => {
    await engine.db.insert(approvals).values([
      {
        workspace_id: harbor.id,
        kind: "message",
        title: "First email to Dana",
        created_at: t("2026-09-19T09:00:00Z"),
      },
      { workspace_id: cedar.id, kind: "message", title: "Not for Harbor" },
    ]);
    const output = (await engine.call(
      "attention.get",
      {},
      { principal: keys.harborAgent as Principal },
    )) as {
      workspace: { id: string };
      counts: { approvals: number };
      approvals: {
        by_kind: Array<{ kind: string; oldest: Array<{ title: string; age_hours: number }> }>;
      };
      warnings: Array<{ code: string; target_id: string | null }>;
      setup: { items: Array<{ key: string; done: boolean }> };
      next_step: string;
    };
    expect(output.workspace.id).toBe(harbor.id);
    expect(output.counts.approvals).toBe(1);
    expect(output.approvals.by_kind[0]?.oldest[0]).toMatchObject({
      title: "First email to Dana",
      age_hours: 3,
    });
    // No brain provider is configured in the test engine.
    expect(output.warnings[0]).toMatchObject({ code: "provider_missing", target_id: "brain" });
    expect(output.next_step).toContain("manage_providers");
    expect(output.setup.items.find((item) => item.key === "leads")?.done).toBe(true);
    // The attention queue and get_status show the same checklist.
    const status = (await engine.call(
      "workspaces.status",
      {},
      { principal: keys.harborAgent as Principal },
    )) as { setup: { items: Array<{ key: string; done: boolean }> } };
    expect(output.setup.items.map((item) => [item.key, item.done])).toEqual(
      status.setup.items.map((item) => [item.key, item.done]),
    );
  });
});

describe("manage_report_schedules through the MCP tool mapping", () => {
  it("advertises one flattened tool with four actions", () => {
    const specs = toolSpecs();
    const tool = specs.get("manage_report_schedules");
    expect(
      Object.fromEntries(Object.entries(tool?.actions ?? {}).map(([k, v]) => [k, v.id])),
    ).toEqual({
      create: "reports.schedules.create",
      list: "reports.schedules.list",
      delete: "reports.schedules.delete",
      run_now: "reports.schedules.run",
    });
    expect(tool?.inputSchema.required).toEqual(["action"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["action", "cron", "channels", "schedule_id", "limit", "workspace"]),
    );
    expect(specs.get("get_report")?.operation?.id).toBe("reports.get");
    expect(specs.get("get_attention_queue")?.operation?.id).toBe("attention.get");
  });

  it("maps each action to its operation and rejects fields an action does not use", async () => {
    const tool = toolSpecs().get("manage_report_schedules");
    const principal = keys.harborAgent as Principal;
    const created = (await callTool(
      tool,
      { action: "create", name: "Mapping check", cron: "0 9 * * 1" },
      principal,
    )) as { id: string; timezone: string; next_run_at: string };
    expect(created).toMatchObject({
      timezone: "Europe/Berlin",
      next_run_at: "2026-09-21T07:00:00.000Z",
    });
    const listed = (await callTool(tool, { action: "list", limit: 10 }, principal)) as {
      items: Array<{ id: string }>;
    };
    expect(listed.items.map((item) => item.id)).toContain(created.id);
    expect(() =>
      prepareCall(tool as McpToolSpec, { action: "list", cron: "0 9 * * 1" }, null),
    ).toThrow(/not used by action "list"/);
    expect(() => prepareCall(tool as McpToolSpec, { action: "pause" }, null)).toThrow(
      /Unknown action/,
    );
    expect(await callTool(tool, { action: "delete", schedule_id: created.id }, principal)).toEqual({
      id: created.id,
      deleted: true,
    });
    await expect(
      callTool(tool, { action: "run_now", schedule_id: created.id }, principal),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("scheduled report from the scheduler to the channels", () => {
  let scheduleId: string;
  const posted = (url: string): FakeRequest[] =>
    engine.fetch.calls.filter((call) => call.url === url && call.method === "POST");

  beforeAll(async () => {
    const principal = keys.harborAgent as Principal;
    const create = async (input: Record<string, unknown>) =>
      (
        (await engine.call("notifications.create", input, { workspace: harbor.slug })) as {
          id: string;
        }
      ).id;
    channels.slack = await create({ type: "slack_webhook", name: "Team Slack", url: SLACK_URL });
    channels.hook = await create({ type: "webhook", name: "Client portal", url: HOOK_URL });
    channels.other = await create({ type: "slack_webhook", name: "Other team", url: OTHER_URL });
    const created = (await callTool(
      toolSpecs().get("manage_report_schedules"),
      {
        action: "create",
        name: "Weekly overview",
        cron: "0 8 * * 1",
        channels: [channels.slack, channels.hook],
        ai_summary: true,
      },
      principal,
    )) as { id: string; next_run_at: string };
    scheduleId = created.id;
    expect(created.next_run_at).toBe("2026-09-21T06:00:00.000Z");
  });

  it("does nothing before the schedule is due", async () => {
    const drained = await engine.runJobs();
    expect(drained.jobs.filter((job) => job.name === REPORT_JOB_NAME)).toEqual([]);
  });

  it("runs on the tick, stores the report and delivers it to the picked channels only", async () => {
    engine.advance(t("2026-09-21T06:01:00Z").getTime() - engine.clock.now().getTime());
    const drained = await engine.runJobs();
    const ours = drained.jobs.filter((job) =>
      [REPORT_JOB_NAME, "notifications.deliver"].includes(job.name),
    );
    expect(ours.map((job) => [job.name, job.status])).toEqual([
      [REPORT_JOB_NAME, "succeeded"],
      ["notifications.deliver", "succeeded"],
      ["notifications.deliver", "succeeded"],
    ]);

    const [row] = await engine.db.select().from(reports).where(eq(reports.workspace_id, harbor.id));
    expect(row?.type).toBe("overview");
    expect(row?.content).toMatchObject({
      schedule_id: scheduleId,
      summary: { text: SUMMARY.summary },
      period: { start_date: "2026-09-14", end_date: "2026-09-20" },
    });
    expect(row?.markdown).toContain(`**Summary:** ${SUMMARY.summary}`);
    expect(row?.delivered_to.map((entry) => [entry.channel_id, entry.ok])).toEqual([
      [channels.slack, true],
      [channels.hook, true],
    ]);

    const [slack] = posted(SLACK_URL);
    const slackBody = JSON.parse(String(slack?.init?.body)) as { text: string; blocks: unknown[] };
    expect(slackBody.text).toBe(
      "Overview report for Harbor Outreach: Last 7 days (2026-09-14 to 2026-09-20)",
    );
    expect(JSON.stringify(slackBody.blocks)).toContain("Replied 2 (+2), reply rate 50.0%");
    const [hook] = posted(HOOK_URL);
    expect(JSON.parse(String(hook?.init?.body))).toMatchObject({
      type: "notification",
      workspace_id: harbor.id,
      event: "report.ready",
      lines: expect.arrayContaining([SUMMARY.summary]),
    });
    expect(posted(OTHER_URL)).toEqual([]);

    const ready = await engine.db
      .select()
      .from(events)
      .where(eq(events.type, "report.ready"))
      .orderBy(asc(events.occurred_at));
    expect(ready.map((event) => [event.workspace_id, event.subject_id])).toEqual([
      [harbor.id, row?.id],
    ]);

    const [schedule] = await engine.db.select().from(schedules).where(eq(schedules.id, scheduleId));
    expect(schedule?.last_run_at?.toISOString()).toBe("2026-09-21T06:01:00.000Z");
    expect(schedule?.next_run_at?.toISOString()).toBe("2026-09-28T06:00:00.000Z");
  });

  it("run_now queues one more run right away", async () => {
    const handle = (await callTool(
      toolSpecs().get("manage_report_schedules"),
      { action: "run_now", schedule_id: scheduleId },
      keys.harborAgent as Principal,
    )) as { job_id: string; status: string };
    expect(handle).toMatchObject({ job_id: expect.stringMatching(/^job_/), status: "queued" });
    const drained = await engine.runJobs();
    expect(
      drained.jobs.filter((job) => job.name === REPORT_JOB_NAME).map((job) => job.status),
    ).toEqual(["succeeded"]);
    const stored = await engine.db
      .select()
      .from(reports)
      .where(eq(reports.workspace_id, harbor.id));
    expect(stored).toHaveLength(2);
    expect(posted(SLACK_URL)).toHaveLength(2);
  });
});

describe("MCP round trip", () => {
  it("serves get_report and manage_report_schedules to an MCP client", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = await serveEmbeddedStdio(engine, {
      toolsets: "core,admin",
      defaultWorkspace: harbor.slug,
      transport: serverSide,
    });
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["get_report", "get_attention_queue", "manage_report_schedules"]),
      );
      const report = (await client.callTool({
        name: "get_report",
        arguments: { type: "overview", format: "markdown" },
      })) as { isError?: boolean; structuredContent?: { markdown?: string } };
      expect(report.isError).toBeFalsy();
      expect(report.structuredContent?.markdown).toContain("## Overview: Harbor Outreach");

      // The local agent has no admin scope.
      const agency = (await client.callTool({
        name: "get_report",
        arguments: { type: "agency" },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(agency.isError).toBe(true);
      expect(agency.content.map((block) => block.text).join("\n")).toContain("forbidden");

      const listed = (await client.callTool({
        name: "manage_report_schedules",
        arguments: { action: "list" },
      })) as { isError?: boolean; structuredContent?: { items?: Array<{ name: string }> } };
      expect(listed.isError).toBeFalsy();
      expect(listed.structuredContent?.items?.map((item) => item.name)).toEqual([
        "Weekly overview",
      ]);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
