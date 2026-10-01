/** List operations: static lists with members and smart lists defined by a filter. */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { LIST_KINDS } from "../../../core/enums.js";
import { notFound, OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, paginated, paginationInput } from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { type List, list_members, lists, people } from "../../../db/schema/index.js";
import { isUniqueViolation } from "../dedupe.js";
import { leadFilterConditions, leadFilterSchema, resolvePeople } from "../filters.js";
import { addToList } from "../list-members.js";
import type { LeadFilter } from "../types.js";
import { EXAMPLE, listSummary } from "./shapes.js";

async function memberCount(ctx: OpContext, list: List): Promise<number> {
  const conditions = await leadFilterConditions(ctx, { list_id: list.id });
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(people)
    .where(and(...conditions));
  return row?.n ?? 0;
}

async function listView(ctx: OpContext, list: List) {
  return { ...list, members: await memberCount(ctx, list) };
}

async function requireList(ctx: OpContext, listId: string): Promise<List> {
  const workspace = requireWorkspace(ctx);
  const [list] = await ctx.db
    .select()
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspace_id, workspace.id)));
  if (!list) throw notFound("List", listId);
  return list;
}

function nameTaken(name: string): OpenOutboundError {
  return new OpenOutboundError("conflict", `A list named "${name}" already exists.`, {
    hint: "Pick another name, or add people to the existing list with manage_lists action add_members.",
    details: { name },
  });
}

export const listLists = defineOperation({
  id: "lists.list",
  summary: "List lead lists",
  description:
    "Lists the workspace's lead lists (static lists with members, and smart lists that match a saved filter) with their current member counts, newest first. Use it to find a list id for search_leads, enroll_leads or exports. Not for the people in a list: use search_leads with list_id. Member counts of smart lists are computed live.",
  effect: "read",
  input: paginationInput.extend({
    query: z.string().max(100).optional().describe("Words in the list name"),
    kind: z.enum(LIST_KINDS).optional(),
  }),
  output: paginated(listSummary),
  http: { method: "GET", path: "/v1/lists" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "All lists", input: { limit: 25 } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(lists.workspace_id, workspace.id)];
    if (input.query)
      conditions.push(sql`${lists.name} ilike ${`%${input.query.replace(/[\\%_]/g, "")}%`}`);
    if (input.kind) conditions.push(eq(lists.kind, input.kind));
    if (input.cursor) {
      const { id } = decodeCursor<{ id?: string }>(input.cursor);
      if (typeof id === "string") conditions.push(sql`${lists.id} < ${id}`);
    }
    const rows = await ctx.db
      .select()
      .from(lists)
      .where(and(...conditions))
      .orderBy(sql`${lists.id} desc`)
      .limit(input.limit + 1);
    const page = toPage(rows, input.limit, (row) => ({ id: row.id }));
    return { ...page, items: await Promise.all(page.items.map((list) => listView(ctx, list))) };
  },
});

export const getList = defineOperation({
  id: "lists.get",
  summary: "Get one list",
  description:
    "Returns one list with its kind, smart filter and current member count. Use it to check what a smart list matches before enrolling it. Not for the members themselves: use search_leads with list_id to page through them. Smart list counts change as people change.",
  effect: "read",
  input: z.object({ list_id: idSchema("ls") }),
  output: listSummary,
  http: { method: "GET", path: "/v1/lists/:list_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Check a list", input: { list_id: EXAMPLE.list } }],
  handler: async (ctx, input) => listView(ctx, await requireList(ctx, input.list_id)),
});

export const createList = defineOperation({
  id: "lists.create",
  summary: "Create a static or smart list",
  description:
    "Creates a static list (you add members) or a smart list (members are everyone matching a saved filter, recomputed on every use). Use static lists for hand-picked batches and imports, smart lists for segments such as fit score 70+ in Germany with a verified email. Not for importing people: import_leads can create the list for you with list_name. Names are unique per workspace.",
  effect: "write",
  input: z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    kind: z.enum(LIST_KINDS).default("static"),
    filter: leadFilterSchema.optional().describe("Smart lists: who belongs"),
    person_ids: z
      .array(idSchema("pe"))
      .max(1_000)
      .optional()
      .describe("Static lists: first members"),
  }),
  output: listSummary,
  http: { method: "POST", path: "/v1/lists" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Smart list of strong fits with verified emails",
      input: {
        name: "Strong fits, verified",
        kind: "smart",
        filter: { min_fit_score: 70, email_status: ["valid"] },
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (input.kind === "smart" && !input.filter) {
      throw new OpenOutboundError("validation_failed", "A smart list needs a filter.", {
        hint: 'Pass filter, for example { min_fit_score: 70, countries: ["DE"] }.',
      });
    }
    if (input.kind === "smart" && input.person_ids?.length) {
      throw new OpenOutboundError("validation_failed", "Smart lists have no hand-picked members.", {
        hint: "Create a static list for person_ids, or describe the members with filter.",
      });
    }
    const name = input.name.trim();
    const [created] = await ctx.db
      .insert(lists)
      .values({
        workspace_id: workspace.id,
        name,
        description: input.description ?? null,
        kind: input.kind,
        filter: input.kind === "smart" ? (input.filter as Record<string, unknown>) : null,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) throw nameTaken(name);
    if (input.kind === "smart") {
      // Validates the filter (unknown list ids fail here).
      await leadFilterConditions(ctx, input.filter as LeadFilter);
    }
    if (input.person_ids?.length) {
      const ids = await resolvePeople(ctx, { personIds: input.person_ids });
      await addToList(ctx, created.id, ids);
    }
    return listView(ctx, created);
  },
});

export const updateList = defineOperation({
  id: "lists.update",
  summary: "Rename a list or change a smart list's filter",
  description:
    "Changes a list's name, description or (for smart lists) filter; the filter is replaced as a whole. Use it to refine a segment or tidy names. Not for adding or removing members of static lists: use manage_lists actions add_members and remove_members. Campaigns that enroll from a smart list see the new filter on their next enrollment.",
  effect: "write",
  input: z.object({
    list_id: idSchema("ls"),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
    filter: leadFilterSchema.optional().describe("Smart lists only: the new filter"),
  }),
  output: listSummary,
  http: { method: "PATCH", path: "/v1/lists/:list_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Rename a list", input: { list_id: EXAMPLE.list, name: "Dental, Texas" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const list = await requireList(ctx, input.list_id);
    if (input.filter && list.kind !== "smart") {
      throw new OpenOutboundError("validation_failed", "Only smart lists have a filter.", {
        hint: "Create a smart list with manage_lists action create and kind smart.",
      });
    }
    if (input.filter) await leadFilterConditions(ctx, input.filter as LeadFilter);
    const patch: Partial<List> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.description !== undefined) patch.description = input.description;
    if (input.filter !== undefined) patch.filter = input.filter as Record<string, unknown>;
    if (Object.keys(patch).length === 0) return listView(ctx, list);
    try {
      const [updated] = await ctx.db
        .update(lists)
        .set({ ...patch, updated_at: ctx.clock.now() })
        .where(and(eq(lists.id, list.id), eq(lists.workspace_id, workspace.id)))
        .returning();
      return listView(ctx, updated ?? list);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(patch.name ?? list.name);
      throw error;
    }
  },
});

export const deleteList = defineOperation({
  id: "lists.delete",
  summary: "Delete a list (people stay)",
  description:
    "Deletes a list and its memberships; the people themselves stay in the workspace. Use it to clean up finished batches or test lists. Not for removing some members (use manage_lists action remove_members) or deleting people (use manage_leads action delete). Saved searches that import into this list stop adding to it.",
  effect: "destructive",
  input: z.object({ list_id: idSchema("ls") }),
  output: z.object({ deleted: z.boolean(), members_removed: z.number().int() }),
  http: { method: "DELETE", path: "/v1/lists/:list_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Delete a test list", input: { list_id: EXAMPLE.list } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const list = await requireList(ctx, input.list_id);
    const members = list.kind === "static" ? await memberCount(ctx, list) : 0;
    await ctx.db
      .delete(lists)
      .where(and(eq(lists.id, list.id), eq(lists.workspace_id, workspace.id)));
    return { deleted: true, members_removed: members };
  },
});

export const addListMembers = defineOperation({
  id: "lists.add_members",
  summary: "Add people to a static list",
  description:
    "Adds people chosen by ids or a filter (up to 5,000) to a static list; people already in it are skipped. Use it to build a batch for a campaign or export. Not for smart lists (change their filter with manage_lists action update) and not for importing new people (use import_leads with list_id). Ids from other workspaces are ignored.",
  effect: "write",
  input: z.object({
    list_id: idSchema("ls"),
    person_ids: z.array(idSchema("pe")).max(5_000).optional(),
    filter: leadFilterSchema.optional(),
  }),
  output: z.object({
    matched: z.number().int(),
    added: z.number().int(),
    members: z.number().int(),
  }),
  http: { method: "POST", path: "/v1/lists/:list_id/members" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Add two people",
      input: { list_id: EXAMPLE.list, person_ids: [EXAMPLE.person, EXAMPLE.person2] },
    },
  ],
  handler: async (ctx, input) => {
    const list = await requireList(ctx, input.list_id);
    if (!input.person_ids && !input.filter) {
      throw new OpenOutboundError("validation_failed", "Say who to add.", {
        hint: "Pass person_ids or filter.",
      });
    }
    const ids = await resolvePeople(ctx, {
      ...(input.person_ids ? { personIds: input.person_ids } : {}),
      ...(input.filter ? { filter: input.filter } : {}),
    });
    if (ids.length > 5_000) {
      throw new OpenOutboundError(
        "validation_failed",
        `That selects ${ids.length} people; the limit is 5,000.`,
        {
          hint: "Narrow the filter or use a smart list instead.",
        },
      );
    }
    const added = await addToList(ctx, list.id, ids);
    return { matched: ids.length, added, members: await memberCount(ctx, list) };
  },
});

export const removeListMembers = defineOperation({
  id: "lists.remove_members",
  summary: "Remove people from a static list",
  description:
    "Removes people from a static list; the people stay in the workspace and in other lists. Use it to take people out of a batch before enrolling or exporting it. Not for smart lists (change their filter) or for deleting people (use manage_leads action delete). People who are not members are ignored.",
  effect: "write",
  input: z.object({
    list_id: idSchema("ls"),
    person_ids: z.array(idSchema("pe")).min(1).max(5_000),
  }),
  output: z.object({ removed: z.number().int(), members: z.number().int() }),
  http: { method: "POST", path: "/v1/lists/:list_id/members/remove" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Remove one person", input: { list_id: EXAMPLE.list, person_ids: [EXAMPLE.person] } },
  ],
  handler: async (ctx, input) => {
    const list = await requireList(ctx, input.list_id);
    if (list.kind === "smart") {
      throw new OpenOutboundError("validation_failed", "Smart lists have no hand-picked members.", {
        hint: "Change the smart list's filter with manage_lists action update.",
      });
    }
    let removed = 0;
    const ids = [...new Set(input.person_ids)];
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await ctx.db
        .delete(list_members)
        .where(
          and(
            eq(list_members.list_id, list.id),
            inArray(list_members.person_id, ids.slice(i, i + 1000)),
          ),
        )
        .returning({ person_id: list_members.person_id });
      removed += rows.length;
    }
    return { removed, members: await memberCount(ctx, list) };
  },
});
