import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { AUDIT_STATUSES, EFFECTS } from "../../core/enums.js";
import {
  dateTimeInput,
  defineOperation,
  isoDateTime,
  paginated,
  paginationInput,
} from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { type AuditEvent, audit_events } from "../../db/schema/index.js";

const auditOutput = z.object({
  id: z.string(),
  occurred_at: isoDateTime(),
  workspace_id: z.string().nullable(),
  actor: z.object({ type: z.string(), id: z.string(), name: z.string() }),
  via: z.string(),
  operation: z.string(),
  effect: z.enum(EFFECTS),
  status: z.enum(AUDIT_STATUSES),
  target: z.object({ type: z.string(), id: z.string() }).nullable(),
  reason: z.string().nullable(),
  summary: z.string().nullable(),
  error_code: z.string().nullable(),
  input: z.record(z.string(), z.unknown()).nullable().optional(),
});

function toAuditView(row: AuditEvent, detailed: boolean): z.input<typeof auditOutput> {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    workspace_id: row.workspace_id,
    actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name },
    via: row.via,
    operation: row.operation,
    effect: row.effect,
    status: row.status,
    target: row.target_type && row.target_id ? { type: row.target_type, id: row.target_id } : null,
    reason: row.reason,
    summary: row.summary,
    error_code: row.error_code,
    ...(detailed ? { input: row.input ?? null } : {}),
  };
}

export const listAudit = defineOperation({
  id: "audit.list",
  summary: "Read the audit log",
  description:
    "Lists audited actions newest first: every non-read call (including failures and dry runs) with actor, door, operation, target, reason and outcome. Use it to answer 'who sent this, who approved that, why'. Filter by operation, status, actor or time range; response_format detailed adds the redacted input. Needs the admin scope.",
  effect: "read",
  scopes: ["admin"],
  input: paginationInput.extend({
    operation: z.string().max(100).optional().describe("Operation id, e.g. approvals.decide"),
    status: z.enum(AUDIT_STATUSES).optional(),
    actor_id: z
      .string()
      .max(100)
      .optional()
      .describe("API key id, local-admin, local-agent or system"),
    since: dateTimeInput().optional().describe("ISO 8601 start (inclusive)"),
    until: dateTimeInput().optional().describe("ISO 8601 end (inclusive)"),
  }),
  output: paginated(auditOutput),
  http: { method: "GET", path: "/v1/audit" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Recent decisions", input: { operation: "approvals.decide" } }],
  handler: async (ctx, input) => {
    const conditions = [];
    if (ctx.workspace) conditions.push(eq(audit_events.workspace_id, ctx.workspace.id));
    if (input.operation) conditions.push(eq(audit_events.operation, input.operation));
    if (input.status) conditions.push(eq(audit_events.status, input.status));
    if (input.actor_id) conditions.push(eq(audit_events.actor_id, input.actor_id));
    if (input.since) conditions.push(gte(audit_events.occurred_at, input.since));
    if (input.until) conditions.push(lte(audit_events.occurred_at, input.until));
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(lt(audit_events.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select()
      .from(audit_events)
      .where(and(...conditions))
      .orderBy(desc(audit_events.id))
      .limit(input.limit + 1);
    const detailed = ctx.request.responseFormat === "detailed";
    return toPage(
      rows,
      input.limit,
      (row) => ({ id: row.id }),
      (row) => toAuditView(row, detailed),
    );
  },
});
