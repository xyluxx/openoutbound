import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import { WORKSPACE_STATUSES } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { isoDateTime } from "../../core/operation.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import type { Workspace } from "../../db/schema/index.js";

export const workspaceOutput = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(WORKSPACE_STATUSES),
  is_sandbox: z.boolean(),
  timezone: z.string(),
  created_at: isoDateTime(),
  updated_at: isoDateTime(),
  settings: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Stored overrides (concise) or effective settings with defaults (detailed)"),
});

export type WorkspaceView = z.input<typeof workspaceOutput>;

/** Workspace row -> output; settings included when asked (overrides, or effective when detailed). */
export function toWorkspaceView(
  workspace: Workspace,
  options: { settings?: "none" | "stored" | "effective" } = {},
): WorkspaceView {
  const view: WorkspaceView = {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    status: workspace.status,
    is_sandbox: workspace.is_sandbox,
    timezone: workspace.timezone,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
  if (options.settings === "stored") view.settings = { ...workspace.settings };
  if (options.settings === "effective") {
    view.settings = parseWorkspaceSettings(workspace.settings) as unknown as Record<
      string,
      unknown
    >;
  }
  return view;
}

/** Throws `validation_failed` unless `timezone` is a valid IANA zone. */
export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new OpenOutboundError("validation_failed", `Unknown timezone "${timezone}".`, {
      hint: 'Use an IANA timezone such as "Europe/Berlin" or "America/New_York".',
      details: { field: "timezone" },
    });
  }
}

/** The principal must not be bound to a workspace (instance-level management). */
export function requireInstancePrincipal(ctx: OpContext, action: string): void {
  if (ctx.principal.workspaceId) {
    throw new OpenOutboundError("forbidden", `A workspace key cannot ${action}.`, {
      hint: "Use an instance-level key (created without a workspace) or the local CLI.",
      details: { reason: "workspace_scope" },
    });
  }
}

/** URL-safe slug from a name ("Harbor Dental Group" -> "harbor-dental-group"). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "workspace";
}
