/**
 * A complete sample module written against the contracts, the way module agents will write
 * theirs. If this file compiles and passes, the contracts compose.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { definePrompt } from "../brain/prompt.js";
import { companies } from "../db/schema/index.js";
import { providers as brainProviders } from "../providers/brain/index.js";
import { createProviderCatalog } from "../providers/registry.js";
import { defineProvider, type ProviderDefinition } from "../providers/types.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { seedCompany } from "../testing/factories.js";
import { requireWorkspace } from "./context.js";
import { notFound } from "./errors.js";
import { idSchema } from "./ids.js";
import {
  type ApprovalResolver,
  awaitingApproval,
  awaitingApprovalOutput,
  defineJob,
  defineOperation,
  defineTool,
  dryRun,
  dryRunOutput,
  type EngineModule,
  isoDateTime,
  jobHandleOutput,
  onEvent,
} from "./operation.js";

const companySummary = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  created_at: isoDateTime(),
});

const summarize = definePrompt({
  id: "demo.summarize_company",
  version: 1,
  tier: "fast",
  system: () => "Summarize the company in one sentence.",
  user: (vars: { name: string }) => `Company: ${vars.name}`,
  schema: z.object({ summary: z.string().min(1) }),
});

const renameCompany = defineOperation({
  id: "demo.rename_company",
  summary: "Rename a company",
  description: "Renames a company. Needs approval when the name changes a lot.",
  effect: "write",
  input: z.object({ company_id: idSchema("co"), name: z.string().min(1) }),
  output: z.union([
    companySummary,
    dryRunOutput(z.object({ from: z.string(), to: z.string() })),
    awaitingApprovalOutput,
  ]),
  http: { method: "POST", path: "/v1/demo/companies/:company_id/rename" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Rename",
      input: { company_id: "co_01k6a3v0q8x3m2n4p5r6s7t8v9", name: "Harbor Dental" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [company] = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.id, input.company_id));
    if (!company || company.workspace_id !== workspace.id)
      throw notFound("Company", input.company_id);
    if (ctx.request.dryRun) return dryRun({ from: company.name, to: input.name });
    if (input.name.length > 40) {
      const { id } = await ctx.approvals.request({
        kind: "custom",
        title: `Rename ${company.name}`,
        summary: `Rename to ${input.name}`,
        payload: { company_id: company.id, name: input.name },
        target: { type: "company", id: company.id },
      });
      return awaitingApproval(id, `Rename to ${input.name} after approval`);
    }
    const [updated] = await ctx.db
      .update(companies)
      .set({ name: input.name })
      .where(eq(companies.id, company.id))
      .returning();
    if (!updated) throw notFound("Company", company.id);
    await ctx.events.emit("lead.updated", {
      subject: { type: "company", id: company.id },
      data: { kind: "company", id: company.id, changes: ["name"] },
    });
    await ctx.jobs.enqueue(
      "demo.summarize",
      { company_id: company.id },
      { singletonKey: `sum:${company.id}` },
    );
    return updated; // a DB row: output.parse() strips extra columns and ISO-formats dates
  },
});

const startSummary = defineOperation({
  id: "demo.start_summary",
  summary: "Summarize a company in the background",
  description: "Starts a background job.",
  effect: "spend",
  input: z.object({ company_id: idSchema("co") }),
  output: jobHandleOutput,
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [],
  handler: (ctx, input) => ctx.jobs.enqueue("demo.summarize", { company_id: input.company_id }),
});

const summarizeJob = defineJob({
  name: "demo.summarize",
  payload: z.object({ company_id: z.string() }),
  handler: async (ctx, payload) => {
    const [company] = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.id, payload.company_id));
    if (!company) return { skipped: true };
    const result = await ctx.brain.run(summarize, { name: company.name }, { jobId: ctx.job.id });
    await ctx.setProgress({ done: 1, total: 1 });
    return { summary: result.output.summary };
  },
});

const onLeadUpdated = onEvent("lead.updated", "demo.log_update", async (ctx, event) => {
  ctx.log.info({ id: event.data.id, changes: event.data.changes }, "lead updated");
});

const renameResolver: ApprovalResolver = {
  kind: "custom",
  apply: async (ctx, approval, decision) => {
    if (decision.decision === "reject") return {};
    const name = String(decision.edits?.name ?? approval.payload.name);
    await ctx.db
      .update(companies)
      .set({ name })
      .where(eq(companies.id, String(approval.payload.company_id)));
    return { message: `Renamed to ${name}` };
  },
};

const demoBrain = defineProvider({
  slot: "brain",
  id: "demo_brain",
  name: "Demo brain",
  description: "Echoes a fixed summary.",
  configSchema: z.object({ model: z.string().default("demo-1") }),
  secrets: [{ key: "api_key", label: "API key", env: "DEMO_API_KEY", required: false }],
  create: ({ config }) => ({
    id: "demo_brain",
    capabilities: { structuredOutput: "native", maxConcurrency: 2, caching: false },
    defaultModels: { fast: config.model },
    generate: async (request) => ({
      text: '{"summary":"ok"}',
      json: { summary: "ok" },
      model: request.model,
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  }),
});

const demoModule: EngineModule = {
  name: "demo",
  operations: [renameCompany, startSummary],
  tools: [
    defineTool({
      name: "manage_demo",
      title: "Demo",
      description: "Demo tool.",
      toolset: "core",
      actions: { rename: "demo.rename_company", summarize: "demo.start_summary" },
    }),
  ],
  jobs: [summarizeJob],
  schedules: [
    { name: "demo.nightly", cron: "0 3 * * *", job: "demo.summarize", perWorkspace: true },
  ],
  eventHandlers: [onLeadUpdated],
  approvalResolvers: [renameResolver],
  httpRoutes: [(app) => app.get("/demo/ping", (c) => c.text("pong"))],
  providers: [demoBrain],
};

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.close()));
});

describe("sample module", () => {
  it("registers every kind of contribution", () => {
    expect(demoModule.operations?.map((op) => op.id)).toEqual([
      "demo.rename_company",
      "demo.start_summary",
    ]);
    const slotList: ProviderDefinition<"brain">[] = [...brainProviders, demoBrain];
    expect(createProviderCatalog(slotList).find("brain", "demo_brain")?.name).toBe("Demo brain");
  });

  it("runs the handler: dry run, direct write, approval", async () => {
    const ctx = await createTestContext();
    contexts.push(ctx);
    const company = await seedCompany(ctx, { name: "Harbor" });

    const preview = await renameCompany.handler(ctx.with({ request: { dryRun: true } }), {
      company_id: company.id,
      name: "Harbor Dental",
    });
    expect(renameCompany.output.parse(preview)).toEqual({
      dry_run: true,
      preview: { from: "Harbor", to: "Harbor Dental" },
      warnings: [],
    });

    const renamed = renameCompany.output.parse(
      await renameCompany.handler(ctx, { company_id: company.id, name: "Harbor Dental" }),
    );
    expect(renamed).toEqual({
      id: company.id,
      name: "Harbor Dental",
      domain: company.domain,
      created_at: company.created_at.toISOString(),
    });
    expect(ctx.emitted("lead.updated")[0]?.data.changes).toEqual(["name"]);
    expect(ctx.enqueued("demo.summarize")).toHaveLength(1);

    const gated = await renameCompany.handler(ctx, {
      company_id: company.id,
      name: "H".repeat(41),
    });
    expect(gated).toMatchObject({ status: "awaiting_approval" });
  });

  it("runs the job with a job context and the fake brain", async () => {
    const ctx = await createTestContext({
      brain: { "demo.summarize_company": { summary: "A dental group." } },
    });
    contexts.push(ctx);
    const company = await seedCompany(ctx);
    const result = await summarizeJob.handler(ctx.jobContext({ name: "demo.summarize" }), {
      company_id: company.id,
    });
    expect(result).toEqual({ summary: "A dental group." });
    expect(ctx.recorded.progress).toHaveLength(1);
  });
});
