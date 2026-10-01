/**
 * Sending volume of a mailbox: its daily limit and ramp. Shared by `mailboxes.update` and the
 * `mailbox_limits` approval, so a held change is applied exactly as it would have been.
 */
import type { z } from "zod";
import type { Mailbox, NewMailbox } from "../../db/schema/index.js";
import {
  rampLimit,
  rampShortened,
  restartedRamp,
  SAFE_DAILY_LIMIT,
  sendingStatus,
} from "./capacity.js";
import { dailyLimitWarning, type rampInput } from "./mailbox-create.js";
import { localDate } from "./timezone.js";

/** A change of daily limit and ramp, as `mailboxes.update` takes it. */
export interface VolumeChange {
  daily_limit?: number | undefined;
  ramp?: z.output<typeof rampInput> | null | undefined;
  restart_ramp?: boolean | undefined;
}

export type VolumePatch = Pick<Partial<NewMailbox>, "daily_limit" | "ramp" | "status">;

/**
 * The daily limit, ramp and sending status after a volume change. A new ramp keeps the
 * mailbox's start date and, unless given, its quiet days; restart_ramp starts it again today at
 * its start volume without the quiet days. Status (for mailboxes that may send): `warming` while
 * the ramp is below the daily limit, `active` once it is complete.
 */
export function volumePatch(
  mailbox: Mailbox,
  change: VolumeChange,
  timezone: string,
  today: string,
): VolumePatch {
  const patch: VolumePatch = {};
  if (change.daily_limit !== undefined) patch.daily_limit = change.daily_limit;
  if (change.ramp === null) patch.ramp = null;
  else if (change.ramp) {
    patch.ramp = {
      ...change.ramp,
      // A mailbox that already sends keeps its current quiet period (none unless it had one).
      delay_days: change.ramp.delay_days ?? mailbox.ramp?.delay_days ?? 0,
      started_at: mailbox.ramp?.started_at ?? today,
    };
  }
  if (change.restart_ramp) {
    const restarted = restartedRamp(patch.ramp ?? mailbox.ramp, today);
    if (change.ramp?.delay_days !== undefined) restarted.delay_days = change.ramp.delay_days;
    patch.ramp = restarted;
  }
  if (
    (patch.ramp !== undefined || patch.daily_limit !== undefined) &&
    (mailbox.status === "active" || mailbox.status === "warming")
  ) {
    const status = sendingStatus(
      patch.daily_limit ?? mailbox.daily_limit,
      patch.ramp === undefined ? mailbox.ramp : patch.ramp,
      localDate(mailbox.created_at, timezone),
      today,
    );
    if (status !== mailbox.status) patch.status = status;
  }
  return patch;
}

export const RAMP_OFF_WARNING = "No ramp: the mailbox sends up to daily_limit from now on.";

export interface VolumeReview {
  /** The same warnings `mailboxes.add` gives, plus one for a shorter ramp. */
  warnings: string[];
  /**
   * What an agent may not do alone, e.g. "raise the daily limit from 30 to 120 a day (above
   * the safe 50)"; empty when a human approval is not needed.
   */
  needsApproval: string[];
}

/**
 * Warnings for a volume change, and what an agent may not do alone: raise the daily limit above
 * SAFE_DAILY_LIMIT, or turn off or shorten the ramp of a mailbox that is still warming.
 */
export function reviewVolume(
  mailbox: Mailbox,
  patch: VolumePatch,
  timezone: string,
  today: string,
): VolumeReview {
  const warnings: string[] = [];
  const needsApproval: string[] = [];
  if (patch.daily_limit !== undefined) {
    const warning = dailyLimitWarning(patch.daily_limit);
    if (warning) warnings.push(warning);
    if (patch.daily_limit > mailbox.daily_limit && patch.daily_limit > SAFE_DAILY_LIMIT) {
      needsApproval.push(
        `raise the daily limit from ${mailbox.daily_limit} to ${patch.daily_limit} a day (above the safe ${SAFE_DAILY_LIMIT})`,
      );
    }
  }
  if (patch.ramp !== undefined) {
    const off = !patch.ramp?.enabled;
    if (off) warnings.push(RAMP_OFF_WARNING);
    const createdDay = localDate(mailbox.created_at, timezone);
    const dailyLimit = patch.daily_limit ?? mailbox.daily_limit;
    const warming =
      sendingStatus(mailbox.daily_limit, mailbox.ramp, createdDay, today) === "warming";
    if (warming && rampShortened(dailyLimit, mailbox.ramp, patch.ramp, createdDay, today)) {
      const now = rampLimit(mailbox.daily_limit, mailbox.ramp, createdDay, today);
      const stage = `while the mailbox is still warming (${now} of ${mailbox.daily_limit} a day today)`;
      if (!off) warnings.push(`The new ramp reaches full volume sooner than the current one.`);
      needsApproval.push(`${off ? "turn off" : "shorten"} the ramp ${stage}`);
    }
  }
  return { warnings, needsApproval };
}
