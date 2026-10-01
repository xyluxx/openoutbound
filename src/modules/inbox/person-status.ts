import type { OpContext } from "../../core/context.js";
import type { PersonStatus } from "../../core/enums.js";
import type { Person } from "../../db/schema/index.js";
import { setPersonStatus } from "../leads/service.js";

const PROGRESS: Partial<Record<PersonStatus, number>> = {
  new: 0,
  active: 0,
  replied: 1,
  interested: 2,
  meeting: 3,
  customer: 4,
};

/** Statuses that stop contact; they win over progress statuses (except `customer`). */
const PROTECTIVE: ReadonlySet<PersonStatus> = new Set([
  "not_interested",
  "do_not_contact",
  "bounced",
  "unsubscribed",
]);

/**
 * Moves a person's status forward (new -> replied -> interested -> meeting -> customer) and
 * applies protective statuses, never downgrading a customer or undoing an opt-out.
 * Returns the status that was set, or null when nothing changed.
 */
export async function advancePersonStatus(
  ctx: OpContext,
  person: Pick<Person, "id" | "status">,
  next: PersonStatus,
): Promise<PersonStatus | null> {
  const current = person.status;
  if (current === next) return null;
  if (current === "customer") return null;
  if (PROTECTIVE.has(current) && !PROTECTIVE.has(next)) return null;
  if (!PROTECTIVE.has(next)) {
    const from = PROGRESS[current] ?? 0;
    const to = PROGRESS[next] ?? 0;
    if (to <= from) return null;
  }
  await setPersonStatus(ctx, person.id, next);
  return next;
}
