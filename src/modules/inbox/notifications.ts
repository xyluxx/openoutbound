import type { OpContext } from "../../core/context.js";
import { type NotifyInput, notify } from "../../runtime/notify.js";

/** Sends a notification; a failing channel never breaks reply handling (logged instead). */
export async function safeNotify(ctx: OpContext, input: NotifyInput): Promise<boolean> {
  try {
    await notify(ctx, input);
    return true;
  } catch (error) {
    ctx.log.warn({ err: error, title: input.title }, "inbox: notification failed");
    return false;
  }
}

/** "Dana Reyes (Harbor Dental)" or the best available label. */
export function personLabel(
  person: { full_name: string | null; email: string | null } | null,
  company: { name: string } | null,
): string {
  const name = person?.full_name?.trim() || person?.email || "Unknown contact";
  return company ? `${name} (${company.name})` : name;
}
