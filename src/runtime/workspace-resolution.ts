/**
 * Which workspace a call acts on (spec 6): explicit `workspace` (id or slug) -> the principal's
 * workspace -> fallback for operations that need one: the only non-archived real workspace,
 * else the only sandbox workspace, else `validation_failed` listing slugs. A workspace-bound
 * principal can never reach another workspace (and never learns whether it exists).
 *
 * The rules work on a `WorkspaceLookup`, so the door tests' fake engine runs the same checks on
 * its in-memory workspaces.
 */
import { asc, eq, ne, or } from "drizzle-orm";
import type { Principal } from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";
import { type AnyOperation, operationCliPath, type WorkspaceMode } from "../core/operation.js";
import type { Db } from "../db/client.js";
import { type Workspace, workspaces } from "../db/schema/index.js";

/** The workspace fields the rules read. */
export type ResolvedWorkspace = Pick<Workspace, "id" | "slug" | "is_sandbox" | "status">;

/** Where the rules find workspaces: the database, or a test double. */
export interface WorkspaceLookup<W extends ResolvedWorkspace = Workspace> {
  /** By id, or by slug (lowercased); null when there is none. */
  find(ref: string): Promise<W | null>;
  /** Every workspace that is not archived, oldest first. */
  candidates(): Promise<W[]>;
}

export function dbWorkspaceLookup(db: Db): WorkspaceLookup {
  return {
    find: (ref) => findWorkspace(db, ref),
    candidates: () =>
      db
        .select()
        .from(workspaces)
        .where(ne(workspaces.status, "archived"))
        .orderBy(asc(workspaces.created_at), asc(workspaces.id)),
  };
}

export async function findWorkspace(db: Db, ref: string): Promise<Workspace | null> {
  const value = ref.trim();
  if (!value) return null;
  const [row] = await db
    .select()
    .from(workspaces)
    .where(or(eq(workspaces.id, value), eq(workspaces.slug, value.toLowerCase())))
    .limit(1);
  return row ?? null;
}

/**
 * Refusal for a principal bound to one workspace that names another. It names the bound
 * workspace (the caller's own) and never says whether the other one exists.
 */
export function workspaceForbidden(boundSlug?: string | null): OpenOutboundError {
  return new OpenOutboundError(
    "forbidden",
    boundSlug
      ? `This key or session is bound to workspace "${boundSlug}" and cannot access another workspace.`
      : "This key or session is bound to one workspace and cannot access that workspace.",
    {
      hint: `Omit \`workspace\` to work in ${boundSlug ?? "the bound workspace"}, or use a key (or an \`openoutbound mcp --workspace\` session) for the other workspace.`,
      details: { reason: "workspace_scope" },
    },
  );
}

/** The refusal for a bound principal, naming the workspace it is bound to. */
async function forbiddenFor<W extends ResolvedWorkspace>(
  lookup: WorkspaceLookup<W>,
  principal: Pick<Principal, "workspaceId">,
): Promise<OpenOutboundError> {
  const own = principal.workspaceId ? await lookup.find(principal.workspaceId) : null;
  return workspaceForbidden(own?.slug ?? null);
}

/**
 * Refusal for an instance-level operation (`workspace: "none"`, `boundPrincipals: "refuse"`)
 * called by a principal bound to one workspace.
 */
export function instanceOnlyForbidden(op: Pick<AnyOperation, "id" | "cli">): OpenOutboundError {
  return new OpenOutboundError(
    "forbidden",
    `${op.id} works on the whole instance, so a key or session bound to one workspace cannot run it.`,
    {
      hint: `Run it with an instance-level key (created without a workspace) or the CLI on the engine's machine: openoutbound ${operationCliPath(op).join(" ")}.`,
      details: { reason: "instance_only", operation: op.id },
    },
  );
}

/** Refuses an instance-level operation to a bound principal (see `BoundPrincipalPolicy`). */
export function assertWorkspacePolicy(
  op: Pick<AnyOperation, "id" | "cli" | "workspace" | "boundPrincipals">,
  principal: Pick<Principal, "workspaceId">,
): void {
  if (op.workspace === "none" && principal.workspaceId && op.boundPrincipals !== "allow") {
    throw instanceOnlyForbidden(op);
  }
}

function lookupOf<W extends ResolvedWorkspace>(
  source: Db | WorkspaceLookup<W>,
): WorkspaceLookup<W> {
  return isLookup(source) ? source : (dbWorkspaceLookup(source) as unknown as WorkspaceLookup<W>);
}

function isLookup<W extends ResolvedWorkspace>(
  source: Db | WorkspaceLookup<W>,
): source is WorkspaceLookup<W> {
  return (
    typeof (source as WorkspaceLookup<W>).find === "function" &&
    typeof (source as WorkspaceLookup<W>).candidates === "function"
  );
}

/**
 * The principal bound to `ref` (id or slug) for one call: an `openoutbound mcp --workspace`
 * session. Never widens: a principal bound to another workspace is refused, and it never learns
 * whether that workspace exists. An unknown workspace for an unbound principal is `not_found`.
 */
export async function bindPrincipal<W extends ResolvedWorkspace>(
  source: Db | WorkspaceLookup<W>,
  principal: Principal,
  ref: string,
): Promise<Principal> {
  const lookup = lookupOf(source);
  const workspace = await lookup.find(ref);
  if (principal.workspaceId) {
    if (!workspace || workspace.id !== principal.workspaceId) {
      throw await forbiddenFor(lookup, principal);
    }
    return principal;
  }
  if (!workspace) {
    throw new OpenOutboundError("not_found", `Workspace "${ref.trim()}" not found.`, {
      hint: "Check the session's --workspace (openoutbound workspaces list shows the slugs); for the sandbox run `openoutbound sandbox` first.",
      details: { what: "Workspace", id: ref.trim() },
    });
  }
  return { ...principal, workspaceId: workspace.id };
}

export async function resolveWorkspace<W extends ResolvedWorkspace = Workspace>(
  source: Db | WorkspaceLookup<W>,
  mode: WorkspaceMode,
  principal: Principal,
  explicit: string | null | undefined,
): Promise<W | null> {
  if (mode === "none") return null;
  const lookup = lookupOf(source);
  const ref = explicit?.trim() || null;
  if (ref) {
    const workspace = await lookup.find(ref);
    if (principal.workspaceId) {
      if (!workspace || workspace.id !== principal.workspaceId) {
        throw await forbiddenFor(lookup, principal);
      }
      return workspace;
    }
    if (!workspace) {
      throw new OpenOutboundError("not_found", `Workspace "${ref}" not found.`, {
        hint: "List workspaces with manage_workspaces action list (CLI: openoutbound workspaces list).",
        details: { what: "Workspace", id: ref },
      });
    }
    return workspace;
  }
  if (principal.workspaceId) {
    const workspace = await lookup.find(principal.workspaceId);
    if (!workspace || workspace.id !== principal.workspaceId) throw workspaceForbidden();
    return workspace;
  }
  if (mode === "optional") return null;

  const candidates = await lookup.candidates();
  const real = candidates.filter((workspace) => !workspace.is_sandbox);
  const sandboxes = candidates.filter((workspace) => workspace.is_sandbox);
  if (real.length === 1 && real[0]) return real[0];
  if (real.length === 0 && sandboxes.length === 1 && sandboxes[0]) return sandboxes[0];
  if (candidates.length === 0) {
    throw new OpenOutboundError(
      "validation_failed",
      "This operation needs a workspace, and none exists yet.",
      {
        hint: "Create one with manage_workspaces action create (CLI: openoutbound workspaces create --name ...), or run `openoutbound sandbox` to practice.",
      },
    );
  }
  const slugs = (real.length > 0 ? real : sandboxes)
    .slice(0, 10)
    .map((workspace) => workspace.slug);
  const example = slugs[0] ?? "my-workspace";
  throw new OpenOutboundError(
    "validation_failed",
    `This operation needs a workspace, and ${real.length > 0 ? real.length : sandboxes.length} are available.`,
    {
      hint: `Pass workspace: '${example}' (one of: ${slugs.join(", ")}).`,
      details: { workspaces: slugs },
    },
  );
}
