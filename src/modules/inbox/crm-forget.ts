/**
 * What happens in the CRM when a person is forgotten (`lead.forgotten`), by `crm.on_forget`:
 * - `task` (default): one `crm_forget` problem per CRM record that held them: their contact
 *   ("Delete contact <id> in <CRM>") and each deal linked to them, which may carry their name or
 *   notes. Owner `person` for the engine's own CRM providers, `agent` for CRMs the agent reported
 *   with `manage_crm` action link. With no known record, one problem asks to find and delete the
 *   person by the email hash: the agent in `crm.mode` agent, a person in built_in mode when a CRM
 *   provider is configured.
 * - `delete`: while `crm.mode` is built_in, contacts in configured providers that can delete are
 *   deleted by a job with retries (a final failure opens the problem instead); every other
 *   record gets the task.
 * - `nothing`: nothing.
 * It runs right away whatever `crm.timing` says: it is a privacy duty, not a sync. Problem texts
 * hold CRM ids and the email hash only, never personal data. Company links are left alone.
 */
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import type { ProblemOwner } from "../../core/enums.js";
import type { EventData } from "../../core/events.js";
import { defineJob, onEvent } from "../../core/operation.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";
import {
  crmDisplayName,
  crmPreferences,
  errorMessage,
  isLastAttempt,
  isRetryable,
} from "./crm-sync.js";

export const CRM_FORGET_DELETE_JOB = "inbox.crm_forget_delete";
/** The engine's own CRM providers; links to any other name came from an agent. */
const BUILT_IN_CRMS: ReadonlySet<string> = new Set(["hubspot", "pipedrive", "webhook", "sandbox"]);

interface ForgottenLink {
  provider: string;
  entity_type: "person" | "opportunity";
  external_id: string;
}

export interface ForgetOutcome {
  /** Problems opened (or refreshed) for someone to act on. */
  tasks: number;
  /** Contacts queued for deletion in a CRM. */
  deletes: number;
}

function where(provider: string): string {
  return provider === "webhook" ? "the CRM your webhook feeds" : crmDisplayName(provider);
}

const forgetKey = (link: ForgottenLink) =>
  `crm_forget:${link.provider}:${link.entity_type}:${link.external_id}`;

/** Opens the "delete it by hand" problem for one CRM record. */
async function openForgetTask(
  ctx: OpContext,
  link: ForgottenLink,
  owner: ProblemOwner,
  extra?: string,
): Promise<void> {
  const crm = where(link.provider);
  const contact = link.entity_type === "person";
  await openProblem(ctx, {
    kind: "crm_forget",
    severity: "normal",
    owner,
    title: contact
      ? `Delete a forgotten contact in ${crm}`
      : `Check a deal in ${crm} for a forgotten person`,
    reason: contact
      ? `A person was forgotten here (erased for privacy), but their contact ${link.external_id} still exists in ${crm}.${extra ? ` ${extra}` : ""}`
      : `A person was forgotten here (erased for privacy). Deal ${link.external_id} in ${crm} was linked to them and may still hold their name or notes.`,
    remedy: contact
      ? `Delete contact ${link.external_id} in ${crm}, then resolve this problem with resolve_exception.`
      : `Open deal ${link.external_id} in ${crm} and remove the person's details (or delete the deal), then resolve this problem with resolve_exception.`,
    data: {
      provider: link.provider,
      entity_type: link.entity_type,
      external_id: link.external_id,
    },
    dedupeKey: forgetKey(link),
  });
}

/** Agent mode without a known CRM id: the agent finds the person by the email hash. */
async function openAgentForgetTask(
  ctx: OpContext,
  data: EventData["lead.forgotten"],
): Promise<void> {
  const hash = data.email_sha256 ?? null;
  await openProblem(ctx, {
    kind: "crm_forget",
    severity: "normal",
    owner: "agent",
    title: "Delete a forgotten person from your CRM",
    reason:
      "A person was forgotten here (erased for privacy). crm.mode is agent and no CRM ids were reported for them, so the engine cannot tell which record in your CRM is theirs.",
    remedy: hash
      ? `Find the contact whose lowercase email has the SHA-256 ${hash} (also email_sha256 in this problem's data) and delete it in your CRM, then resolve this problem with resolve_exception. Report CRM ids with manage_crm action link from now on.`
      : "The engine kept no email hash for this person. Check your CRM for contacts you synced from here that no longer exist in OpenOutbound, delete them, then resolve this problem with resolve_exception.",
    data: { email_sha256: hash },
    dedupeKey: hash ? `crm_forget:agent:${hash}` : null,
  });
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Built-in mode without a known CRM id: the configured CRMs may still hold the person (a sync
 * whose link was lost, a contact made by hand), so a person searches them by the email hash.
 * Nothing when no CRM is configured or no hash was kept. Returns whether a task was opened.
 */
async function openBuiltInSearchTask(
  ctx: OpContext,
  data: EventData["lead.forgotten"],
): Promise<boolean> {
  const hash = data.email_sha256 ?? null;
  if (!hash) return false;
  const configured = await ctx.providers.list("crm");
  if (configured.length === 0) return false;
  const crms = listNames(configured.map((crm) => where(crm.id)));
  await openProblem(ctx, {
    kind: "crm_forget",
    severity: "normal",
    owner: "person",
    title: "Search your CRM for a forgotten person",
    reason: `A person was forgotten here (erased for privacy). No CRM record was linked to them, so the engine cannot tell whether ${crms} still holds their contact.`,
    remedy: `Search ${crms} for the contact whose lowercase email has the SHA-256 ${hash} (also email_sha256 in this problem's data) and delete it, then resolve this problem with resolve_exception. If no contact matches, just resolve it.`,
    data: { email_sha256: hash, providers: configured.map((crm) => crm.id) },
    dedupeKey: `crm_forget:built_in:${hash}`,
  });
  return true;
}

/** The person and deal links of the event, without duplicates or malformed rows. */
function forgottenLinks(data: EventData["lead.forgotten"]): ForgottenLink[] {
  const seen = new Set<string>();
  const links: ForgottenLink[] = [];
  for (const link of Array.isArray(data?.crm_links) ? data.crm_links : []) {
    if (
      typeof link?.provider !== "string" ||
      typeof link.external_id !== "string" ||
      !link.provider ||
      !link.external_id ||
      (link.entity_type !== "person" && link.entity_type !== "opportunity")
    ) {
      continue;
    }
    const entry: ForgottenLink = {
      provider: link.provider,
      entity_type: link.entity_type,
      external_id: link.external_id,
    };
    const key = forgetKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(entry);
  }
  return links;
}

/** Applies `crm.on_forget` to a forgotten person (see the file comment). */
export async function handleForgottenLead(
  ctx: OpContext,
  data: EventData["lead.forgotten"],
): Promise<ForgetOutcome> {
  const preferences = crmPreferences(ctx);
  const outcome: ForgetOutcome = { tasks: 0, deletes: 0 };
  if (preferences.on_forget === "nothing") return outcome;
  const links = forgottenLinks(data);
  if (links.length === 0) {
    if (preferences.mode === "agent") {
      await openAgentForgetTask(ctx, data);
      outcome.tasks += 1;
    } else if (preferences.mode === "built_in" && (await openBuiltInSearchTask(ctx, data))) {
      outcome.tasks += 1;
    }
    return outcome;
  }
  const configured = await ctx.providers.list("crm");
  for (const link of links) {
    const crm = configured.find((candidate) => candidate.id === link.provider);
    const canDelete =
      preferences.on_forget === "delete" &&
      preferences.mode === "built_in" &&
      link.entity_type === "person" &&
      typeof crm?.deleteContact === "function";
    if (canDelete) {
      await ctx.jobs.enqueue(
        CRM_FORGET_DELETE_JOB,
        { provider: link.provider, external_id: link.external_id },
        { singletonKey: `${CRM_FORGET_DELETE_JOB}:${link.provider}:${link.external_id}` },
      );
      outcome.deletes += 1;
      continue;
    }
    const own = BUILT_IN_CRMS.has(link.provider) || Boolean(crm);
    await openForgetTask(ctx, link, own ? "person" : "agent");
    outcome.tasks += 1;
  }
  return outcome;
}

export const crmOnLeadForgotten = onEvent(
  "lead.forgotten",
  "inbox.crm_forget",
  async (ctx, event) => {
    await handleForgottenLead(ctx, event.data);
  },
);

/**
 * Deletes one forgotten contact in a CRM. Temporary failures retry; a final failure (or a
 * provider that is gone or cannot delete) opens the `crm_forget` problem so a person does it.
 */
export async function deleteForgottenContact(
  ctx: OpContext,
  provider: string,
  externalId: string,
): Promise<{ status: "deleted" | "already_gone" | "task" | "failed" }> {
  const link: ForgottenLink = { provider, entity_type: "person", external_id: externalId };
  const crm = await ctx.providers.tryGet("crm", { id: provider });
  if (!crm?.deleteContact) {
    await openForgetTask(
      ctx,
      link,
      "person",
      `${where(provider)} is no longer configured here, or cannot delete contacts.`,
    );
    return { status: "task" };
  }
  try {
    const { deleted } = await crm.deleteContact(externalId);
    await resolveProblemsFor(ctx, { dedupeKey: forgetKey(link) }, `Deleted in ${where(provider)}.`);
    return { status: deleted ? "deleted" : "already_gone" };
  } catch (error) {
    const retry = isRetryable(error);
    if (!retry || isLastAttempt(ctx)) {
      await openForgetTask(
        ctx,
        link,
        "person",
        `Deleting it automatically failed: ${errorMessage(error)}`,
      );
      if (!retry) return { status: "failed" };
    }
    throw error;
  }
}

export const crmForgetDeleteJob = defineJob({
  name: CRM_FORGET_DELETE_JOB,
  payload: z.object({ provider: z.string().min(1), external_id: z.string().min(1) }),
  maxAttempts: 6,
  backoff: { type: "exponential", baseMs: 60_000, maxMs: 3_600_000 },
  handler: (ctx, payload) => deleteForgottenContact(ctx, payload.provider, payload.external_id),
});
