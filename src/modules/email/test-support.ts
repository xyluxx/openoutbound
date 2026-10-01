/**
 * Test doubles for the leads service functions the email module calls (the real leads module
 * lands separately). Tests wire them with
 * `vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService)`.
 * They write the same rows the real functions do, so assertions can read the database.
 */
import { and, eq, inArray } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { PersonStatus, SuppressionReason, SuppressionType } from "../../core/enums.js";
import { people, suppressions } from "../../db/schema/index.js";

const BLOCKED: PersonStatus[] = ["unsubscribed", "bounced", "do_not_contact"];

export const fakeLeadsService = {
  async checkContactable(
    ctx: OpContext,
    input: { personId: string; channel: "email" | "linkedin" },
  ): Promise<{ ok: boolean; reasons: string[] }> {
    const workspace = requireWorkspace(ctx);
    const [person] = await ctx.db
      .select()
      .from(people)
      .where(and(eq(people.workspace_id, workspace.id), eq(people.id, input.personId)));
    if (!person) return { ok: false, reasons: ["not_found"] };
    const reasons: string[] = [];
    if (BLOCKED.includes(person.status)) reasons.push(`status_${person.status}`);
    // Tests add real leads reason codes (consent_required, catch_all_skipped, ...) this way.
    const extra = person.custom?.contactable_reasons;
    if (Array.isArray(extra)) reasons.push(...extra.map(String));
    const email = person.email?.toLowerCase() ?? "";
    if (input.channel === "email" && !email) reasons.push("no_email");
    if (email) {
      const rows = await ctx.db
        .select({ type: suppressions.type })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.workspace_id, workspace.id),
            inArray(suppressions.value, [email, email.slice(email.lastIndexOf("@") + 1)]),
          ),
        );
      if (rows.length > 0) reasons.push("suppressed_email");
    }
    return { ok: reasons.length === 0, reasons };
  },

  async addSuppression(
    ctx: OpContext,
    input: {
      type: SuppressionType;
      value: string;
      reason: SuppressionReason;
      source: string;
      note?: string;
    },
  ): Promise<void> {
    const workspace = requireWorkspace(ctx);
    await ctx.db
      .insert(suppressions)
      .values({
        workspace_id: workspace.id,
        type: input.type,
        value: input.value.toLowerCase(),
        reason: input.reason,
        source: input.source,
        note: input.note ?? null,
      })
      .onConflictDoNothing();
  },

  async setPersonStatus(ctx: OpContext, personId: string, status: PersonStatus): Promise<void> {
    const workspace = requireWorkspace(ctx);
    await ctx.db
      .update(people)
      .set({ status })
      .where(and(eq(people.workspace_id, workspace.id), eq(people.id, personId)));
  },
};
