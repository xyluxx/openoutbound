/**
 * sandbox.seed, sandbox.status and sandbox.simulate: the only operations this module exposes.
 * Everything else (world data, providers, the prospect simulator's event handler and jobs) works
 * through them or through the provider resolver.
 */
import { z } from "zod";
import { requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { defineOperation } from "../../core/operation.js";
import { sandboxStatus, seedAllSandboxWorkspaces } from "../../sandbox/seed.js";
import { fastForwardSandbox } from "../../sandbox/simulator/fast-forward.js";
import { countSandboxOutbox } from "../../sandbox/simulator/outbox.js";
import { SANDBOX_WORLD_KEYS } from "../../sandbox/world/index.js";

const seedCountsSchema = z.object({
  companies: z.number(),
  people: z.number(),
  lists: z.number(),
  list_members: z.number(),
  icps: z.number(),
  knowledge_items: z.number(),
  offers: z.number(),
  signals: z.number(),
  campaigns: z.number(),
  campaign_steps: z.number(),
  mailboxes: z.number(),
  linkedin_accounts: z.number(),
  threads: z.number(),
  messages: z.number(),
  suppressions: z.number(),
});

const pendingSimulationSchema = z.object({
  email_replies: z.number().describe("Simulated replies and bounces to emails of ours"),
  linkedin_accepts: z.number().describe("Simulated prospects about to accept an invitation"),
  linkedin_replies: z.number().describe("Simulated answers to LinkedIn messages of ours"),
  meeting_bookings: z
    .number()
    .describe("Prospects about to book a meeting with the link in a reply of ours"),
  meeting_no_shows: z.number().describe("Booked meetings that were due and will be no-shows"),
});

const outboxSchema = z.object({
  emails_sent: z.number().describe("Emails sent so far, to the simulator (never to a real person)"),
  linkedin_sent: z.number().describe("LinkedIn actions sent so far, to the simulator"),
  waiting: z
    .number()
    .describe("Approved or scheduled messages that wait for their send window or a free slot"),
});

const seededWorkspaceSchema = z.object({
  workspace_id: z.string(),
  slug: z.string(),
  name: z.string(),
  created: z.boolean(),
  reset: z.boolean(),
  counts: seedCountsSchema,
  quick_start_prompts: z.array(z.string()),
});

/**
 * MCP tools (and actions) worth trying first, shown by sandbox.status regardless of workspace.
 * Each entry starts with a tool name agents can call (checked in mcp.test.ts).
 */
const TRY_FIRST_HINTS = [
  "find_leads - search the sandbox world for new companies and people to import",
  "get_attention_queue - see replies and approvals waiting for a decision",
  "research_lead - pull a dated, sourced research brief for a company or person",
  "preview_campaign - draft the next message of a campaign without sending anything",
  "manage_sandbox action simulate - fast-forward pending simulated replies and LinkedIn acceptances now, for demos and evals (admin toolset: start the MCP server with --toolsets core,admin)",
];

export const seedSandbox = defineOperation({
  id: "sandbox.seed",
  summary: "Create or reset the sandbox workspaces",
  description:
    "Creates the two invented sandbox workspaces (northwind: Northwind Analytics, a B2B SaaS agency demo; brightsmile: Brightsmile Dental Supply, a local-business demo) with knowledge, leads, signals, a draft campaign, mailboxes and a LinkedIn account, so anyone can try the outbound loop with zero keys and zero risk. Without reset it only fills in whatever is missing, so it is safe to call again; reset deletes and rebuilds them. It only ever creates, changes or deletes workspaces marked as sandbox: when a real workspace already uses a world's slug it refuses with conflict, and you seed that world under another slug with world and slug. Use sandbox.status instead if you only want to see what already exists.",
  effect: "admin",
  input: z.object({
    reset: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Delete and recreate the sandbox workspaces from scratch (only sandbox workspaces are ever deleted).",
      ),
    world: z
      .enum(SANDBOX_WORLD_KEYS)
      .optional()
      .describe("Only this practice world: northwind or brightsmile. Default: both."),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "Use lowercase letters, digits and hyphens" })
      .max(48)
      .optional()
      .describe(
        "Slug for that world's sandbox workspace when a real workspace already uses its usual one, e.g. northwind-sandbox. Needs world.",
      ),
  }),
  output: z.object({ workspaces: z.array(seededWorkspaceSchema) }),
  http: { method: "POST", path: "/v1/sandbox/seed" },
  dryRun: "none",
  idempotent: true,
  workspace: "none",
  // Creates and deletes workspaces: instance-level work for an unbound admin.
  boundPrincipals: "refuse",
  examples: [
    { title: "Fill in anything missing", input: {} },
    { title: "Reset both workspaces", input: { reset: true } },
    {
      title: "Northwind under another slug (a real workspace is called northwind)",
      input: { world: "northwind", slug: "northwind-sandbox" },
    },
  ],
  handler: async (ctx, input) => {
    const workspacesResult = await seedAllSandboxWorkspaces(ctx, input.reset, {
      ...(input.world ? { world: input.world } : {}),
      ...(input.slug ? { slug: input.slug } : {}),
    });
    return { workspaces: workspacesResult };
  },
});

export const getSandboxStatus = defineOperation({
  id: "sandbox.status",
  summary: "Show what exists in the sandbox workspaces",
  description:
    "Reports per-table counts for each sandbox workspace that has already been seeded, the simulated replies and acceptances that will arrive, plus a short list of tools worth trying first. Use this before sandbox.seed to check whether the sandbox is already set up, or any time after to confirm what exists. Read-only, never modifies anything; returns an empty list if sandbox.seed has not run yet.",
  effect: "read",
  input: z.object({}),
  output: z.object({
    workspaces: z.array(
      z.object({
        workspace_id: z.string(),
        slug: z.string(),
        name: z.string(),
        counts: seedCountsSchema,
        quick_start_prompts: z.array(z.string()),
        pending_simulated_replies: pendingSimulationSchema,
      }),
    ),
    try_first: z.array(z.string()),
  }),
  http: { method: "GET", path: "/v1/sandbox/status" },
  dryRun: "none",
  idempotent: true,
  workspace: "none",
  // A workspace-bound caller sees only its own workspace, when it is a sandbox.
  boundPrincipals: "allow",
  examples: [{ title: "Check sandbox status", input: {} }],
  handler: async (ctx) => {
    const all = await sandboxStatus(ctx);
    const bound = ctx.principal.workspaceId;
    const workspacesStatus = bound ? all.filter((row) => row.workspace_id === bound) : all;
    return { workspaces: workspacesStatus, try_first: TRY_FIRST_HINTS };
  },
});

export const simulateSandbox = defineOperation({
  id: "sandbox.simulate",
  summary: "Fast-forward pending simulated replies",
  description:
    "Immediately delivers every simulated email reply, bounce, LinkedIn invite acceptance and meeting booking (from a reply of ours with the booking link) that is waiting on its short simulated delay in this sandbox workspace, and reports what the workspace sent so far (outbox). Use this in a demo or eval when you do not want to wait a few simulated minutes for the outbound loop to show a reply. Only works in a sandbox workspace; does nothing to real campaigns. Most simulated prospects never answer, so pending counts only what will arrive; booked meetings keep their simulated time (1 to 3 days after the reply), so no-shows and held meetings show up once that time has passed.",
  // Write, not admin: it only delivers early what the simulator delivers on its own, so agents
  // (MCP: manage_sandbox action simulate) can call it with their default scopes.
  effect: "write",
  input: z.object({}),
  output: z.object({
    workspace: z.string().describe("Workspace slug"),
    pending_before: pendingSimulationSchema,
    delivered: pendingSimulationSchema,
    outbox: outboxSchema,
  }),
  http: { method: "POST", path: "/v1/sandbox/simulate" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Fast-forward this sandbox workspace", input: {} }],
  handler: async (ctx) => {
    const workspace = requireWorkspace(ctx);
    if (!workspace.is_sandbox) {
      throw new OpenOutboundError(
        "validation_failed",
        `Workspace "${workspace.slug}" is not a sandbox workspace, so it has no simulated replies.`,
        {
          hint: "Pass a sandbox workspace, northwind or brightsmile (manage_sandbox action status lists them). Create them with `openoutbound sandbox`.",
        },
      );
    }
    const result = await fastForwardSandbox(ctx, workspace.id);
    const { delivered, ...pending_before } = result;
    const outbox = await countSandboxOutbox(ctx, workspace.id);
    return { workspace: workspace.slug, pending_before, delivered, outbox };
  },
});
