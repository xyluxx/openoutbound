/**
 * The cold email check before the first email to a person. The send job asks the compliance
 * provider (`settings.compliance.cold_email_check`, Precleared by default) whether a cold email
 * may go to the address, stores the verdict on the person (leads/cold-email.ts) and acts on it
 * through the gate's last check (relationships/checks-email.ts). Replies, reply-mode steps and
 * follow-ups (an email to the person went out in the last 30 days) are never checked, nor is a
 * sandbox workspace (no provider resolves there). A definite verdict is reused for 30 days for
 * the same address and facts, so a sequence costs one check and `unknown` is asked again.
 *
 * Mode `hold` (the default): only `ok_to_email` goes out. consent_needed, blocked and unknown
 * skip the email with the provider's reason, next step and receipt, and a check that could not
 * run (no network, a rejected key, the allowance used up, a server error) holds the email until
 * a retry and opens one `sending_blocked` problem per workspace with the provider's own words.
 * Mode `warn` logs the verdict or the failure and sends anyway. Mode `off` never asks.
 */
import { and, eq, gte, inArray, ne } from "drizzle-orm";
import type { JobContext, OpContext } from "../../core/context.js";
import { failureOf, retryAfterOf } from "../../core/failures.js";
import type { WorkspaceSettings } from "../../core/settings.js";
import {
  type Company,
  type EmailClearance,
  type Message,
  messages,
  type Person,
  type Workspace,
} from "../../db/schema/index.js";
import type { ComplianceProvider, EmailCheckInput } from "../../providers/types.js";
import {
  addressSourceOf,
  cachedClearance,
  clearanceInputs,
  countryFromEmail,
  recipientNameOf,
  recordEmailClearance,
} from "../leads/service.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";
import type { ColdEmailCheckOutcome } from "../relationships/eligibility-types.js";

/** Blocker code of an email held because the check could not run (relationships/blockers.ts). */
export const COLD_EMAIL_CHECK_FAILED = "cold_email_check_failed";

/** How long a held email waits before the check is tried again, unless the provider said. */
export const COLD_EMAIL_RECHECK_MS = 30 * 60_000;

/** An email to the person this recent makes the next one a follow-up: no check. */
const FOLLOW_UP_WINDOW_MS = 30 * 86_400_000;

/** One problem per workspace for this reason. */
const DEDUPE_KEY = "sending_blocked:cold_email_check";

export interface ColdEmailCheckContext {
  workspace: Workspace;
  settings: WorkspaceSettings;
  message: Message;
  person: Person;
  company: Company | null;
  recipient: string;
  now: Date;
}

/** The input for the provider, built from what the engine knows (never a guess as a fact). */
export function checkInputFor(
  context: Pick<ColdEmailCheckContext, "settings" | "person" | "company" | "recipient">,
): Omit<EmailCheckInput, "signal"> {
  const { settings, person, company, recipient } = context;
  const number = company?.custom?.company_number;
  const country = person.country ?? company?.country ?? null;
  return {
    email: recipient,
    sender_country: settings.compliance.cold_email_check.sender_country,
    address_source: addressSourceOf(person),
    company_name: company?.name ?? null,
    recipient_name: recipientNameOf(person),
    company_number: typeof number === "string" ? number : null,
    recipient_country: country,
    // The ccTLD only fills a gap: the provider uses it when nothing else says the country.
    default_recipient_country: country ? null : countryFromEmail(recipient),
  };
}

/** An engine email to the person went out in the last 30 days: the next one is a follow-up. */
async function emailedRecently(
  ctx: OpContext,
  context: Pick<ColdEmailCheckContext, "workspace" | "message" | "person" | "now">,
): Promise<boolean> {
  const [recent] = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, context.workspace.id),
        eq(messages.person_id, context.person.id),
        eq(messages.channel, "email"),
        eq(messages.direction, "outbound"),
        eq(messages.origin, "engine"),
        inArray(messages.status, ["sent", "bounced"]),
        gte(messages.sent_at, new Date(context.now.getTime() - FOLLOW_UP_WINDOW_MS)),
        ne(messages.id, context.message.id),
      ),
    )
    .limit(1);
  return recent !== undefined;
}

function held(clearance: EmailClearance): ColdEmailCheckOutcome {
  if (clearance.verdict === "ok_to_email") return { kind: "clear" };
  return {
    kind: "held",
    verdict: clearance.verdict,
    reason: clearance.reason,
    next_step: clearance.next_step,
    receipt_id: clearance.receipt_id,
  };
}

/**
 * The check for one send: null when nothing is to be checked, else the outcome the gate acts
 * on. In mode `warn` every outcome is logged and the email is clear.
 */
export async function checkColdEmail(
  ctx: JobContext,
  context: ColdEmailCheckContext,
): Promise<ColdEmailCheckOutcome | null> {
  const { settings, message, person, now } = context;
  const { mode, provider: providerId } = settings.compliance.cold_email_check;
  if (mode === "off" || message.action === "reply") return null;
  if (await emailedRecently(ctx, context)) return null;
  let provider: ComplianceProvider | null;
  try {
    provider = await ctx.providers.tryGet("compliance", { id: providerId });
  } catch (error) {
    // The provider could not be built (its config, the vault): held like a check that failed.
    return holdFor(ctx, error, context, providerId);
  }
  if (!provider) {
    if (!context.workspace.is_sandbox) {
      ctx.log.warn(
        { message_id: message.id, provider: providerId },
        "email: the cold email check's provider is not installed; sending without the check",
      );
    }
    return null;
  }
  const input = checkInputFor(context);
  const inputs = clearanceInputs(input);
  const cached = cachedClearance(person, inputs, now);
  const outcome = cached
    ? held(cached)
    : await askProvider(ctx, provider, { ...input, signal: ctx.job.signal }, context, inputs);
  if (mode !== "warn") return outcome;
  if (outcome.kind === "held") {
    ctx.log.warn(
      {
        message_id: message.id,
        person_id: person.id,
        verdict: outcome.verdict,
        reason: outcome.reason,
        next_step: outcome.next_step,
        receipt_id: outcome.receipt_id,
      },
      "email: the cold email check did not clear the address; sending anyway (mode warn)",
    );
  } else if (outcome.kind === "unavailable") {
    ctx.log.warn(
      { message_id: message.id, person_id: person.id, error: outcome.message },
      "email: the cold email check could not run; sending anyway (mode warn)",
    );
  }
  return { kind: "clear" };
}

/** Asks the provider, stores its answer on the person and turns a failure into a hold. */
async function askProvider(
  ctx: JobContext,
  provider: ComplianceProvider,
  input: EmailCheckInput,
  context: ColdEmailCheckContext,
  inputs: string,
): Promise<ColdEmailCheckOutcome> {
  const { message, person, recipient, now } = context;
  try {
    const result = await provider.checkEmail(input);
    const clearance: EmailClearance = {
      provider: provider.id,
      email: recipient,
      verdict: result.verdict,
      reason: result.reason,
      next_step: result.next_step,
      receipt_id: result.receipt_id,
      recipient_country: result.recipient_country ?? null,
      checked_at: now.toISOString(),
      inputs,
    };
    await recordEmailClearance(ctx, person.id, clearance);
    // The provider answers again: a hold for a check that could not run is over.
    await resolveColdEmailHoldProblem(ctx);
    ctx.log.info(
      {
        message_id: message.id,
        person_id: person.id,
        provider: provider.id,
        verdict: result.verdict,
        receipt_id: result.receipt_id,
      },
      "email: cold email check answered",
    );
    return held(clearance);
  } catch (error) {
    return holdFor(ctx, error, context, provider.id);
  }
}

/**
 * A check that could not run, as a hold: the error's words and hint, and the next try after
 * the wait the provider asked for (else COLD_EMAIL_RECHECK_MS, at most a day).
 */
function holdFor(
  ctx: JobContext,
  error: unknown,
  context: Pick<ColdEmailCheckContext, "message" | "person" | "now">,
  providerId: string,
): ColdEmailCheckOutcome {
  const { message, person, now } = context;
  const failure = failureOf(error);
  const text = error instanceof Error ? error.message : String(error);
  const hint = (error as { hint?: unknown }).hint;
  const retryAfter = retryAfterOf(error);
  const waitMs =
    retryAfter !== undefined && retryAfter > 0 ? retryAfter * 1000 : COLD_EMAIL_RECHECK_MS;
  ctx.log.warn(
    {
      message_id: message.id,
      person_id: person.id,
      provider: providerId,
      failure: failure?.class ?? null,
      err: text,
    },
    "email: the cold email check could not run",
  );
  return {
    kind: "unavailable",
    message: text,
    hint: typeof hint === "string" && hint.trim() ? hint : null,
    retry_at: new Date(now.getTime() + Math.min(waitMs, 86_400_000)),
  };
}

/**
 * Opens (or refreshes) the workspace's `sending_blocked` problem for a check that cannot run,
 * with the provider's words (`message`) and the held blocker's fix (`remedy`).
 */
export async function openColdEmailHoldProblem(
  ctx: OpContext,
  hold: { message: string; remedy: string | null; retryAt: Date },
): Promise<void> {
  const minutes = Math.max(
    1,
    Math.round((hold.retryAt.getTime() - ctx.clock.now().getTime()) / 60_000),
  );
  await openProblem(ctx, {
    kind: "sending_blocked",
    severity: "high",
    owner: "person",
    title: "Cold emails are held: the cold email check cannot run",
    reason: `${hold.message} Emails to people not checked yet stay scheduled and are checked again (next try in about ${minutes} minutes). Replies, follow-ups and people already cleared still go out.`,
    remedy: `${hold.remedy ? `${hold.remedy} ` : ""}The problem closes by itself once a check succeeds.`,
    data: { message: hold.message, retry_at: hold.retryAt.toISOString() },
    dedupeKey: DEDUPE_KEY,
  });
}

/** After a check answered: the hold's problem is over. */
export async function resolveColdEmailHoldProblem(ctx: OpContext): Promise<void> {
  await resolveProblemsFor(
    ctx,
    { dedupeKey: DEDUPE_KEY },
    "The cold email check answers again; held emails go out at their next check.",
  );
}
