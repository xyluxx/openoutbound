import { and, asc, eq, gt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { MAILBOX_STATUSES } from "../../../core/enums.js";
import { defineOperation, paginated, paginationInput } from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { mailboxes } from "../../../db/schema/index.js";
import { mailboxSummarySchema, summarizeMailboxes } from "../mailbox-summary.js";

export const listMailboxes = defineOperation({
  id: "mailboxes.list",
  summary: "List sending mailboxes with health and today's usage",
  description:
    "Lists the workspace's mailboxes with status, today's limit after the ramp, emails sent and scheduled today, 7-day bounce rate, failure streak, throttling, last IMAP sync and the stored DNS check. Use it to pick mailboxes for a campaign or to find out why sending slowed down. It never returns passwords or tokens. For campaign-level numbers use get_report instead.",
  effect: "read",
  input: paginationInput.extend({
    status: z.enum(MAILBOX_STATUSES).optional().describe("Only mailboxes with this status"),
  }),
  output: paginated(mailboxSummarySchema),
  http: { method: "GET", path: "/v1/mailboxes" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Paused mailboxes", input: { status: "paused", limit: 25 } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const filters: SQL[] = [eq(mailboxes.workspace_id, workspace.id)];
    if (input.status) filters.push(eq(mailboxes.status, input.status));
    if (input.cursor) {
      const cursor = decodeCursor<{ id?: unknown }>(input.cursor);
      if (typeof cursor.id === "string") filters.push(gt(mailboxes.id, cursor.id));
    }
    const rows = await ctx.db
      .select()
      .from(mailboxes)
      .where(and(...filters))
      .orderBy(asc(mailboxes.id))
      .limit(input.limit + 1);
    const page = toPage(rows, input.limit, (row) => ({ id: row.id }));
    return { ...page, items: await summarizeMailboxes(ctx, workspace, page.items) };
  },
});
