import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { actorRef } from "../../core/context.js";
import { API_KEY_KINDS, SCOPES, type Scope } from "../../core/enums.js";
import { forbidden, notFound, OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import { defineOperation, isoDateTime, paginated, paginationInput } from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { type ApiKey, api_keys } from "../../db/schema/index.js";
import {
  creatorExpiry,
  defaultScopesForKind,
  generateApiKey,
  revokeKeysCreatedBy,
} from "../../runtime/api-keys.js";
import { workspaceForbidden } from "../../runtime/workspace-resolution.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const keyOutput = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(API_KEY_KINDS),
  prefix: z.string().describe("First 11 characters, to recognize the key"),
  scopes: z.array(z.enum(SCOPES)),
  workspace_id: z.string().nullable().describe("null = instance key (every workspace)"),
  last_used_at: isoDateTime().nullable(),
  expires_at: isoDateTime().nullable(),
  revoked_at: isoDateTime().nullable(),
  created_at: isoDateTime(),
});

function toKeyView(row: ApiKey): z.input<typeof keyOutput> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    prefix: row.prefix,
    scopes: row.scopes,
    workspace_id: row.workspace_id,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

export const createKey = defineOperation({
  id: "keys.create",
  summary: "Create an API key",
  description:
    "Creates an API key for the REST API, remote MCP or CLI bridge and returns the plain key once (only its hash is stored, so store it immediately). Pass `workspace` for a key bound to one workspace; without it the key is instance-wide, and a key bound to a workspace only creates keys bound to that workspace. Agent keys default to read, write, send, spend (no approve, no admin) so a human stays in the loop, and you cannot grant scopes you do not have. Only a person can create a `human` key, because a human key holding approve skips approval requests. A key created with another key never outlives it: it expires no later than that key (by default when it does), and revoking that key revokes it too.",
  effect: "admin",
  input: z.object({
    name: z.string().min(1).max(100).describe("Who or what uses it, e.g. 'Claude Code on laptop'"),
    kind: z.enum(API_KEY_KINDS).default("agent").describe("human | agent | service"),
    scopes: z
      .array(z.enum(SCOPES))
      .min(1)
      .optional()
      .describe("Default: agent read,write,send,spend; human all; service read,write"),
    expires_in_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe(
        "Default: never, or when the key creating it expires. Never later than that key's expiry",
      ),
  }),
  output: keyOutput.extend({
    key: z.string().describe("The plain API key. Shown once."),
    warning: z.string(),
  }),
  http: { method: "POST", path: "/v1/keys" },
  dryRun: "none",
  idempotent: false,
  workspace: "optional",
  examples: [{ title: "Agent key for one client", input: { name: "Claude Code", kind: "agent" } }],
  handler: async (ctx, input) => {
    // A human key holding approve skips approval requests: only a person may mint one.
    if (input.kind === "human" && ctx.principal.type !== "human") {
      throw new OpenOutboundError(
        "forbidden",
        `Only a person can create a human key; this caller is ${ctx.principal.type === "agent" ? "an agent" : `a ${ctx.principal.type}`} (${ctx.principal.name}).`,
        {
          hint: "Create an agent or service key instead, or ask a person to create the human key (openoutbound keys create --kind human).",
          details: { reason: "human_key", kind: input.kind },
        },
      );
    }
    // A key bound to a workspace never mints keys for another workspace or the whole instance.
    if (ctx.principal.workspaceId && ctx.workspace?.id !== ctx.principal.workspaceId) {
      throw workspaceForbidden();
    }
    const scopes = [...new Set<Scope>(input.scopes ?? defaultScopesForKind(input.kind))];
    const missing = scopes.find((scope) => !ctx.principal.scopes.includes(scope));
    if (missing) throw forbidden(missing);
    // A key never outlives the key that creates it (nor the keys that one was created from).
    const requested = input.expires_in_days
      ? new Date(ctx.clock.now().getTime() + input.expires_in_days * DAY_MS)
      : null;
    const cap = await creatorExpiry(ctx.db, ctx.principal);
    const capped = cap !== null && (requested === null || requested.getTime() > cap.getTime());
    const generated = generateApiKey();
    const [row] = await ctx.db
      .insert(api_keys)
      .values({
        workspace_id: ctx.workspace?.id ?? null,
        name: input.name,
        kind: input.kind,
        prefix: generated.prefix,
        hash: generated.hash,
        scopes,
        expires_at: capped ? cap : requested,
        created_by: actorRef(ctx.principal),
        created_at: ctx.clock.now(),
      })
      .returning();
    if (!row) throw new OpenOutboundError("internal", "Failed to create the key.");
    return {
      ...toKeyView(row),
      key: generated.key,
      warning: capped
        ? `Store this key now: it is shown only once. It expires at ${cap.toISOString()}, with the key that created it: a key never outlives its creator.`
        : "Store this key now: it is shown only once.",
    };
  },
});

export const listKeys = defineOperation({
  id: "keys.list",
  summary: "List API keys",
  description:
    "Lists API keys with their prefix, kind, scopes, workspace and last use, newest first; plain keys are never shown. With `workspace` (or a workspace key) only that workspace's keys are listed; an instance admin without `workspace` sees every key. Use it to find stale or leaked keys to revoke. Revoked keys are hidden unless include_revoked is true.",
  effect: "read",
  scopes: ["admin"],
  input: paginationInput.extend({
    include_revoked: z.boolean().default(false),
  }),
  output: paginated(keyOutput),
  http: { method: "GET", path: "/v1/keys" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Active keys", input: {} }],
  handler: async (ctx, input) => {
    const conditions = [];
    if (ctx.workspace) conditions.push(eq(api_keys.workspace_id, ctx.workspace.id));
    if (!input.include_revoked) conditions.push(isNull(api_keys.revoked_at));
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(lt(api_keys.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select()
      .from(api_keys)
      .where(and(...conditions))
      .orderBy(desc(api_keys.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }), toKeyView);
  },
});

export const revokeKey = defineOperation({
  id: "keys.revoke",
  summary: "Revoke an API key",
  description:
    "Revokes an API key immediately: every later request with it fails with unauthorized. Every key created with it, and the keys those created, down the chain, is revoked too (also_revoked lists them). Use it when a key leaked or is no longer needed; create a replacement first if something still depends on it or on a key it created. Workspace keys can only revoke keys of their own workspace. Revoking twice is harmless.",
  effect: "admin",
  input: z.object({ key_id: idSchema("key").describe("Key id from keys.list (key_...)") }),
  output: keyOutput.extend({
    also_revoked: z
      .array(z.string())
      .describe("Keys created from this one, down the chain, revoked with it now"),
  }),
  http: { method: "POST", path: "/v1/keys/:key_id/revoke" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Revoke", input: { key_id: "key_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    // Workspace keys (or an explicit workspace) only reach that workspace's keys.
    const scope = ctx.workspace ? eq(api_keys.workspace_id, ctx.workspace.id) : undefined;
    const [row] = await ctx.db
      .select()
      .from(api_keys)
      .where(and(eq(api_keys.id, input.key_id), scope))
      .limit(1);
    if (!row) throw notFound("API key", input.key_id);
    const now = ctx.clock.now();
    return ctx.db.transaction(async (tx) => {
      const [updated] = row.revoked_at
        ? [row]
        : await tx
            .update(api_keys)
            .set({ revoked_at: now })
            .where(eq(api_keys.id, row.id))
            .returning();
      // Also on a second call: a key created from it since (or before revoking cascaded) ends.
      const also = await revokeKeysCreatedBy(tx, row.id, now);
      return { ...toKeyView(updated ?? row), also_revoked: also };
    });
  },
});
