import { and, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { people, suppressions } from "../../db/schema/index.js";
import { addSuppression, setPersonStatus } from "../leads/service.js";

export type UnsubscribeSource = "link" | "one_click" | "reply" | "manual";

/**
 * Unsubscribes an address: email suppression, person status `unsubscribed`, event
 * `unsubscribe.received`. Idempotent: a second request for the same address does nothing and
 * reports `alreadyUnsubscribed`.
 */
export async function processUnsubscribe(
  ctx: OpContext,
  input: {
    email: string;
    personId?: string | null;
    messageId?: string | null;
    source: UnsubscribeSource;
  },
): Promise<{ alreadyUnsubscribed: boolean; personId: string | null }> {
  const workspace = requireWorkspace(ctx);
  const email = input.email.trim().toLowerCase();

  const personQuery = input.personId
    ? eq(people.id, input.personId)
    : email
      ? eq(people.email, email)
      : null;
  const [person] = personQuery
    ? await ctx.db
        .select({ id: people.id, status: people.status })
        .from(people)
        .where(and(eq(people.workspace_id, workspace.id), personQuery))
        .limit(1)
    : [];

  const [existing] = email
    ? await ctx.db
        .select({ reason: suppressions.reason })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.workspace_id, workspace.id),
            eq(suppressions.type, "email"),
            eq(suppressions.value, email),
          ),
        )
        .limit(1)
    : [];
  const personDone = !person || person.status === "unsubscribed";
  if (existing?.reason === "unsubscribed" && personDone) {
    return { alreadyUnsubscribed: true, personId: person?.id ?? null };
  }

  if (email) {
    await addSuppression(ctx, {
      type: "email",
      value: email,
      reason: "unsubscribed",
      source: input.source === "reply" ? "reply" : "unsubscribe_link",
      note: `Unsubscribed via ${input.source.replace("_", "-")}`,
    });
  }
  if (person && person.status !== "unsubscribed") {
    await setPersonStatus(ctx, person.id, "unsubscribed");
  }
  await ctx.events.emit("unsubscribe.received", {
    subject: person ? { type: "person", id: person.id } : null,
    data: {
      person_id: person?.id ?? null,
      email: email || null,
      source: input.source,
      message_id: input.messageId ?? null,
    },
  });
  return { alreadyUnsubscribed: false, personId: person?.id ?? null };
}
