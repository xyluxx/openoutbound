/** Agency report: scope check and all workspaces side by side. Clock: 2026-09-19 12:00 UTC. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Workspace } from "../../db/schema/index.js";
import { approvals, usage_records } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson, seedWorkspace } from "../../testing/factories.js";
import { getReport } from "./operations/get-report.js";
import type { ReportOutput } from "./schemas.js";

const t = (iso: string) => new Date(iso);

let ctx: TestContext;
let beta: Workspace;
let sandbox: Workspace;

async function agency(input: Record<string, unknown> = {}, context: TestContext = ctx) {
  const raw = await getReport.handler(context, getReport.input.parse({ type: "agency", ...input }));
  return getReport.output.parse(raw) as ReportOutput;
}

async function seedActivity(
  workspace: Workspace,
  args: { sends: number; replies: number; aiCost: number; previousSends?: number },
) {
  const target = { db: ctx.db, workspace };
  for (let i = 0; i < args.sends; i++) {
    const person = await seedPerson(target, { created_at: t("2026-08-01T00:00:00Z") });
    await seedMessage(target, {
      person_id: person.id,
      status: "sent",
      sent_at: t(`2026-09-1${3 + (i % 5)}T10:00:00Z`),
    });
    if (i < args.replies) {
      await seedMessage(target, {
        person_id: person.id,
        direction: "inbound",
        status: "received",
        action: "reply",
        received_at: t(`2026-09-1${3 + (i % 5)}T15:00:00Z`),
        classification: { category: i === 0 ? "interested" : "question", confidence: 0.9 },
      });
    }
  }
  for (let i = 0; i < (args.previousSends ?? 0); i++) {
    const person = await seedPerson(target, { created_at: t("2026-08-01T00:00:00Z") });
    await seedMessage(target, {
      person_id: person.id,
      status: "sent",
      sent_at: t("2026-09-08T10:00:00Z"),
    });
  }
  await ctx.db.insert(usage_records).values({
    workspace_id: workspace.id,
    slot: "brain",
    provider: "anthropic",
    operation: "campaign.email.write",
    cost_usd: args.aiCost,
    created_at: t("2026-09-14T10:00:00Z"),
  });
}

beforeAll(async () => {
  ctx = await createTestContext({
    workspace: { name: "Acme Outreach", timezone: "America/New_York" },
    principal: { workspaceId: null },
  });
  beta = await seedWorkspace(ctx.db, { name: "Beta | Partners" });
  sandbox = await seedWorkspace(ctx.db, { name: "Sandbox", is_sandbox: true });
  await seedWorkspace(ctx.db, { name: "Archived Co", status: "archived" });

  await seedActivity(ctx.workspace, { sends: 4, replies: 2, aiCost: 1.5, previousSends: 2 });
  await seedActivity(beta, { sends: 1, replies: 0, aiCost: 0.25 });
  await seedActivity(sandbox, { sends: 5, replies: 5, aiCost: 9 });
  await ctx.db.insert(approvals).values([
    { workspace_id: ctx.workspace.id, kind: "message", title: "Email 1" },
    { workspace_id: ctx.workspace.id, kind: "reply", title: "Reply 1" },
  ]);
  await seedMailbox({ db: ctx.db, workspace: beta }, { status: "paused" });
});

afterAll(async () => {
  await ctx.close();
});

describe("agency report access", () => {
  it("refuses a principal bound to one workspace", async () => {
    const bound = ctx.with({ principal: { workspaceId: ctx.workspace.id } });
    await expect(agency({}, bound)).rejects.toMatchObject({
      code: "forbidden",
      hint: expect.stringContaining("instance-level API key"),
    });
  });

  it("refuses an instance principal without the admin scope", async () => {
    const reader = ctx.with({ principal: { scopes: ["read", "write"] } });
    await expect(agency({}, reader)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("agency report", () => {
  it("shows every workspace but archived ones, sorted by name, in UTC", async () => {
    const output = await agency();
    expect(output.workspace).toBeNull();
    expect(output.period).toMatchObject({ timezone: "UTC", from: "2026-09-12T00:00:00.000Z" });
    if (output.data?.type !== "agency") throw new Error("expected agency data");
    const data = output.data;
    expect(data.workspaces.map((row) => row.name)).toEqual([
      "Acme Outreach",
      "Beta | Partners",
      "Sandbox",
    ]);
    const [acme, betaRow, sandboxRow] = data.workspaces;
    expect(acme?.metrics.contacted).toEqual({ value: 4, previous: 2, change: 2, change_pct: 100 });
    expect(acme?.metrics.replies.value).toBe(2);
    expect(acme?.metrics.positive_replies.value).toBe(1);
    expect(acme?.metrics.reply_rate.value).toBe(50);
    expect(acme?.metrics.ai_cost_usd.value).toBe(1.5);
    expect(acme?.pending_approvals).toBe(2);
    expect(acme?.warnings).toBe(0);
    expect(betaRow?.metrics.contacted.value).toBe(1);
    expect(betaRow?.warnings).toBe(1);
    expect(sandboxRow).toMatchObject({ is_sandbox: true });
    expect(sandboxRow?.metrics.replies.value).toBe(5);

    expect(data.totals_exclude_sandbox).toBe(true);
    expect(data.totals.contacted).toEqual({ value: 5, previous: 2, change: 3, change_pct: 150 });
    expect(data.totals.replies.value).toBe(2);
    expect(data.totals.reply_rate.value).toBe(40);
    expect(data.totals.ai_cost_usd.value).toBe(1.75);
    expect(output.notes).toContain("Totals leave out sandbox workspaces.");
  });

  it("accepts a timezone and renders markdown and csv", async () => {
    const zoned = await agency({ timezone: "Europe/Berlin", compare: false });
    expect(zoned.period.from).toBe("2026-09-11T22:00:00.000Z");
    expect(zoned.previous_period).toBeNull();

    const markdown = (await agency({ format: "markdown" })).markdown ?? "";
    expect(markdown).toContain("## Agency overview\n");
    expect(markdown).toContain("| Acme Outreach | 4 (+2) | 2 (+2) | 1 (+1) | 0 (0) | 50.0% |");
    expect(markdown).toContain("| Beta \\| Partners |");
    expect(markdown).toContain("| **Total (excluding sandbox)** | 5 (+3) |");

    const csv = (await agency({ format: "csv" })).csv ?? "";
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      "workspace_id,workspace,status,is_sandbox,contacted,emails_sent,linkedin_sent,replies,positive_replies,meetings,reply_rate,positive_rate,bounce_rate,ai_cost_usd,data_credits,pending_approvals,warnings",
    );
    expect(lines[2]).toBe(`${beta.id},Beta | Partners,active,false,1,1,0,0,0,0,0,0,0,0.25,0,0,1`);
  });
});
