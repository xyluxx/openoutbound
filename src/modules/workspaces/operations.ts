import { and, asc, eq, gt, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { WORKSPACE_STATUSES } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { defineOperation, paginated, paginationInput } from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { mergeSettings, type WorkspaceSettingsInput } from "../../core/settings.js";
import { type Workspace, workspaces } from "../../db/schema/index.js";
import { notify } from "../../runtime/notify.js";
import { loosenedGateRefusal } from "./safety.js";
import {
  assertTimezone,
  requireInstancePrincipal,
  slugify,
  toWorkspaceView,
  workspaceOutput,
} from "./schemas.js";
import { updateWorkspaceRow, validateWorkspaceSettings as validateSettings } from "./service.js";

const settingsInput = z
  .record(z.string(), z.unknown())
  .describe(
    "Workspace settings to change (deep-merged into the current ones), e.g. { ai: { monthly_budget_usd: 50 } }. Sections: company, schedule, compliance, sending, ai, data, approvals, replies, booking, inbox, lead_file, strategy, crm, sandbox.",
  );

async function uniqueSlug(ctx: Pick<OpContext, "db">, base: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 44)}-${n}`;
    const [taken] = await ctx.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  throw new OpenOutboundError("conflict", "Could not find a free slug for this workspace.", {
    hint: "Pass an explicit slug.",
  });
}

export const listWorkspaces = defineOperation({
  id: "workspaces.list",
  summary: "List workspaces",
  description:
    "Lists the workspaces (one per client or brand) this key can see, oldest first. Use it to find the slug to pass as `workspace` when you manage several clients. Workspace keys only see their own workspace. Archived workspaces are hidden unless you filter by status archived.",
  effect: "read",
  input: paginationInput.extend({
    status: z
      .enum(WORKSPACE_STATUSES)
      .optional()
      .describe("Only this status (default: not archived)"),
    query: z.string().max(100).optional().describe("Part of the name or slug"),
  }),
  output: paginated(workspaceOutput),
  http: { method: "GET", path: "/v1/workspaces" },
  dryRun: "none",
  idempotent: true,
  workspace: "none",
  // A workspace key sees only its own workspace (the handler filters).
  boundPrincipals: "allow",
  examples: [{ title: "Active workspaces", input: { status: "active" } }],
  handler: async (ctx, input) => {
    const conditions = [];
    if (ctx.principal.workspaceId) conditions.push(eq(workspaces.id, ctx.principal.workspaceId));
    if (input.status) conditions.push(eq(workspaces.status, input.status));
    else conditions.push(or(eq(workspaces.status, "active"), eq(workspaces.status, "paused")));
    if (input.query) {
      const pattern = `%${input.query.replace(/[%_\\]/g, "\\$&")}%`;
      conditions.push(or(ilike(workspaces.name, pattern), ilike(workspaces.slug, pattern)));
    }
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(gt(workspaces.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select()
      .from(workspaces)
      .where(and(...conditions))
      .orderBy(asc(workspaces.id))
      .limit(input.limit + 1);
    const detailed = ctx.request.responseFormat === "detailed";
    return toPage(
      rows,
      input.limit,
      (row) => ({ id: row.id }),
      (row) => toWorkspaceView(row, { settings: detailed ? "stored" : "none" }),
    );
  },
});

export const createWorkspace = defineOperation({
  id: "workspaces.create",
  summary: "Create a workspace",
  description:
    "Creates a workspace: an isolated space with its own knowledge, leads, senders, campaigns and settings (one per client or brand). Use it once per client before adding anything else. Do not use it to practice: run `openoutbound sandbox` for a sandbox workspace with fake data. Needs an instance-level admin key; settings that loosen a gate (see workspaces.update) are for a person holding the approve scope only.",
  effect: "admin",
  input: z.object({
    name: z.string().min(1).max(120).describe("Display name, e.g. the client's company name"),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "Use lowercase letters, digits and hyphens" })
      .max(48)
      .optional()
      .describe("URL-safe id used as `workspace` in calls. Default: derived from the name"),
    timezone: z.string().optional().describe("IANA timezone for schedules, default UTC"),
    is_sandbox: z.boolean().optional().describe("Sandbox workspaces use fake providers only"),
    settings: settingsInput.optional(),
  }),
  output: workspaceOutput,
  http: { method: "POST", path: "/v1/workspaces" },
  dryRun: "none",
  idempotent: false,
  workspace: "none",
  boundPrincipals: "refuse",
  examples: [
    {
      title: "New client workspace",
      input: { name: "Harbor Dental Group", timezone: "America/Chicago" },
    },
  ],
  handler: async (ctx, input) => {
    requireInstancePrincipal(ctx, "create workspaces");
    if (input.timezone) assertTimezone(input.timezone);
    const settings = (input.settings ?? {}) as Record<string, unknown>;
    validateSettings(settings);
    // A new workspace starts from the defaults: loosening a gate there is loosening it too.
    const refusal = loosenedGateRefusal(ctx.principal, {}, settings);
    if (refusal) throw refusal;
    let slug: string;
    if (input.slug) {
      const [taken] = await ctx.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, input.slug))
        .limit(1);
      if (taken) {
        throw new OpenOutboundError("conflict", `The slug "${input.slug}" is already used.`, {
          hint: "Pick another slug, or omit it to derive one from the name.",
          details: { field: "slug" },
        });
      }
      slug = input.slug;
    } else slug = await uniqueSlug(ctx, slugify(input.name));
    const [row] = await ctx.db
      .insert(workspaces)
      .values({
        slug,
        name: input.name,
        timezone: input.timezone ?? "UTC",
        is_sandbox: input.is_sandbox ?? false,
        settings: settings as WorkspaceSettingsInput,
        created_at: ctx.clock.now(),
        updated_at: ctx.clock.now(),
      })
      .returning();
    if (!row) throw new OpenOutboundError("internal", "Failed to create the workspace.");
    return toWorkspaceView(row, { settings: "stored" });
  },
});

export const getWorkspace = defineOperation({
  id: "workspaces.get",
  summary: "Get a workspace and its settings",
  description:
    "Returns the workspace with its settings: stored overrides by default, or every effective setting with defaults when response_format is detailed. Use it before changing settings to see the current values. For setup progress and warnings use workspaces.status (get_status) instead. Settings never contain secrets.",
  effect: "read",
  input: z.object({}),
  output: workspaceOutput,
  http: { method: "GET", path: "/v1/workspace" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Current workspace", input: {} }],
  handler: async (ctx) =>
    toWorkspaceView(requireWorkspace(ctx), {
      settings: ctx.request.responseFormat === "detailed" ? "effective" : "stored",
    }),
});

export const updateWorkspace = defineOperation({
  id: "workspaces.update",
  summary: "Update a workspace (name, timezone, settings)",
  description:
    "Changes the workspace name, slug, timezone or settings; settings are deep-merged, so send only what changes (null clears a nullable setting). Use it for budgets, compliance, approvals and reply rules. Use workspaces.pause / resume for the sending kill switch instead. Locked reply rules (unsubscribe, privacy_request, bounce, negative) cannot be changed. Needs the admin scope: an agent without it suggests the change with manage_strategy action propose (operation workspaces.update), except a budget, which it asks the human to change. Loosening a gate (approvals.agent_launch_requires_approval off, approvals.agent_changes auto, a lower approvals.default_review_level, a higher or removed AI or data budget, a reply rule set to auto_reply) is for a person holding the approve scope: anyone else gets forbidden naming the fields, even with admin, and nothing changes.",
  effect: "admin",
  forbiddenHint:
    'To suggest the change instead, use manage_strategy action propose (operation workspaces.update, input {"settings": {...}}) with a reason; the owner approves it. A budget is the owner\'s call: ask the human to change it (openoutbound workspaces update).',
  input: z.object({
    name: z.string().min(1).max(120).optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "Use lowercase letters, digits and hyphens" })
      .max(48)
      .optional(),
    timezone: z.string().optional(),
    settings: settingsInput.optional(),
    archived: z
      .boolean()
      .optional()
      .describe("true archives the workspace (hidden, nothing runs); false restores it as active"),
  }),
  output: workspaceOutput,
  http: { method: "PATCH", path: "/v1/workspace" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Set an AI budget", input: { settings: { ai: { monthly_budget_usd: 50 } } } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const changes: Partial<Workspace> = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.timezone !== undefined) {
      assertTimezone(input.timezone);
      changes.timezone = input.timezone;
    }
    if (input.slug !== undefined && input.slug !== workspace.slug) {
      const [taken] = await ctx.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, input.slug))
        .limit(1);
      if (taken) {
        throw new OpenOutboundError("conflict", `The slug "${input.slug}" is already used.`, {
          hint: "Pick another slug.",
          details: { field: "slug" },
        });
      }
      changes.slug = input.slug;
    }
    const patch = input.settings as Record<string, unknown> | undefined;
    if (patch !== undefined) validateSettings(patch);
    if (input.archived === true) changes.status = "archived";
    if (Object.keys(changes).length === 0 && patch === undefined && input.archived !== false)
      return toWorkspaceView(workspace, { settings: "stored" });
    // Settings merge into what is stored (read under a row lock), not into the copy this request
    // loaded, so concurrent updates keep each other's changes.
    const row = await updateWorkspaceRow(ctx, (stored) => {
      const set = { ...changes };
      if (patch !== undefined) {
        set.settings = mergeSettings(
          stored.settings as Record<string, unknown>,
          patch,
        ) as WorkspaceSettingsInput;
      }
      if (input.archived === false && stored.status === "archived") set.status = "active";
      return set;
    });
    return toWorkspaceView(row, { settings: "stored" });
  },
});

const pauseOutput = workspaceOutput.extend({ message: z.string() });

export const pauseWorkspace = defineOperation({
  id: "workspaces.pause",
  summary: "Pause all sending (kill switch)",
  description:
    "Stops all sending in the workspace immediately: emails, LinkedIn actions and auto-replies stay queued, and send operations fail with workspace_paused. Use it when something looks wrong (bounces, bad copy, angry replies); reply sync and research keep running. Resume with workspaces.resume. Pass `reason` so humans know why.",
  effect: "write",
  input: z.object({}),
  output: pauseOutput,
  http: { method: "POST", path: "/v1/workspace/pause" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Stop sending now", input: {} }],
  handler: async (ctx) => {
    const workspace = requireWorkspace(ctx);
    if (workspace.status === "archived") {
      throw new OpenOutboundError("conflict", "The workspace is archived; nothing is sending.", {
        hint: "Restore it with workspaces.update archived:false first.",
      });
    }
    if (workspace.status === "paused") {
      return { ...toWorkspaceView(workspace), message: "The workspace was already paused." };
    }
    const [row] = await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, workspace.id))
      .returning();
    if (!row) throw new OpenOutboundError("internal", "Failed to pause the workspace.");
    await notify(ctx, {
      title: `Sending paused in ${row.name}`,
      lines: [
        `Paused by ${ctx.principal.name}.`,
        ...(ctx.request.reason ? [`Reason: ${ctx.request.reason}`] : []),
      ],
      severity: "warning",
    });
    return {
      ...toWorkspaceView(row),
      message: "Sending is paused. Resume with workspaces.resume.",
    };
  },
});

export const resumeWorkspace = defineOperation({
  id: "workspaces.resume",
  summary: "Resume sending after a pause",
  description:
    "Lifts the kill switch: queued emails and LinkedIn actions continue within their normal limits and windows. Use it only after the reason for the pause is fixed (check get_status warnings first). Needs the send scope, because it allows sending again. Archived workspaces are restored with workspaces.update instead.",
  effect: "write",
  scopes: ["write", "send"],
  input: z.object({}),
  output: pauseOutput,
  http: { method: "POST", path: "/v1/workspace/resume" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Resume sending", input: {} }],
  handler: async (ctx) => {
    const workspace = requireWorkspace(ctx);
    if (workspace.status === "archived") {
      throw new OpenOutboundError("conflict", "The workspace is archived.", {
        hint: "Restore it with workspaces.update archived:false.",
      });
    }
    if (workspace.status === "active") {
      return { ...toWorkspaceView(workspace), message: "The workspace was not paused." };
    }
    const [row] = await ctx.db
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspace.id))
      .returning();
    if (!row) throw new OpenOutboundError("internal", "Failed to resume the workspace.");
    await ctx.jobs.wake(`workspace_active:${row.id}`);
    await notify(ctx, {
      title: `Sending resumed in ${row.name}`,
      lines: [`Resumed by ${ctx.principal.name}.`],
      severity: "info",
    });
    return { ...toWorkspaceView(row), message: "Sending resumed." };
  },
});
