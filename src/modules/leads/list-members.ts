/** Static list membership shared by operations, imports and enrichment. */
import { and, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { list_members, lists } from "../../db/schema/index.js";

/**
 * Adds people to a static list (idempotent); returns how many were new members. Callers pass
 * ids already resolved inside the workspace.
 */
export async function addToList(
  ctx: OpContext,
  listId: string,
  personIds: string[],
): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const [list] = await ctx.db
    .select()
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspace_id, workspace.id)));
  if (!list) throw notFound("List", listId);
  if (list.kind === "smart") {
    throw new OpenOutboundError(
      "validation_failed",
      "Smart lists fill themselves from their filter.",
      {
        hint: "Add people to a static list, or change the smart list's filter with manage_lists.",
        details: { list_id: listId },
      },
    );
  }
  let added = 0;
  for (let i = 0; i < personIds.length; i += 500) {
    const rows = await ctx.db
      .insert(list_members)
      .values(personIds.slice(i, i + 500).map((person_id) => ({ list_id: listId, person_id })))
      .onConflictDoNothing()
      .returning({ person_id: list_members.person_id });
    added += rows.length;
  }
  return added;
}
