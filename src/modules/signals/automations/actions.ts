/** Runs (or previews) one automation action for a signal. Failures become results, not throws. */
import { createHmac } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { OpContext } from "../../../core/context.js";
import { type EventData, type EventType, isEventType } from "../../../core/events.js";
import {
  type AutomationActionResult,
  type AutomationRule,
  campaigns,
  companies,
  list_members,
  lists,
  type Person,
  people,
} from "../../../db/schema/index.js";
import { notify } from "../../../runtime/notify.js";
import { requestResearch } from "../../research/service.js";
import type { AutomationSubject } from "./filters.js";
import { DEFAULT_PEOPLE_PER_ACTION, ENROLL_REQUESTED, type StoredAction } from "./schema.js";

export interface ActionRun {
  ctx: OpContext;
  rule: AutomationRule;
  subject: AutomationSubject;
  /** People that passed the rule's filters (best first). */
  people: Person[];
  /** Id of the firing row, sent as the webhook delivery id. */
  firingId: string;
  /** False until the core event map knows automation.enroll_requested. */
  enrollEventAvailable: boolean;
}

export const WEBHOOK_TIMEOUT_MS = 10_000;

/** `t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>` (OpenOutbound webhook convention). */
export function signWebhookBody(secret: string, body: string, unixSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${v1}`;
}

export function enrollEventAvailable(): boolean {
  return isEventType(ENROLL_REQUESTED);
}

function pick(run: ActionRun, max: number | undefined): Person[] {
  return run.people.slice(0, Math.max(1, max ?? DEFAULT_PEOPLE_PER_ACTION));
}

function personName(person: Person): string {
  return (
    person.full_name ??
    ([person.first_name, person.last_name].filter(Boolean).join(" ") || person.id)
  );
}

function subjectLabel(subject: AutomationSubject): string {
  if (subject.person && subject.company)
    return `${personName(subject.person)} (${subject.company.name})`;
  if (subject.person) return personName(subject.person);
  return subject.company?.name ?? "unknown company";
}

const failed = (type: string, detail: string): AutomationActionResult => ({
  type,
  status: "failed",
  detail,
});
const skipped = (type: string, detail: string): AutomationActionResult => ({
  type,
  status: "skipped",
  detail,
});

async function runNotify(
  run: ActionRun,
  action: Extract<StoredAction, { type: "notify" }>,
): Promise<AutomationActionResult> {
  const { signal } = run.subject;
  const lines = [
    `${signal.definition_key}, score ${signal.score}`,
    signal.evidence_url ? `Evidence: ${signal.evidence_url}` : null,
    run.people.length > 0 ? `People: ${run.people.slice(0, 5).map(personName).join(", ")}` : null,
    `Automation: ${run.rule.name}`,
  ].filter((line): line is string => line !== null);
  await notify(run.ctx, {
    title: `Signal at ${subjectLabel(run.subject)}: ${signal.title}`,
    lines,
    severity: action.severity ?? "info",
    event: "signal.detected",
  });
  return { type: "notify", status: "ok" };
}

async function runAddToList(
  run: ActionRun,
  action: Extract<StoredAction, { type: "add_to_list" }>,
): Promise<AutomationActionResult> {
  const workspaceId = run.subject.signal.workspace_id;
  const [list] = await run.ctx.db
    .select({ id: lists.id, kind: lists.kind })
    .from(lists)
    .where(and(eq(lists.workspace_id, workspaceId), eq(lists.id, action.list_id)));
  if (!list) return failed("add_to_list", `List ${action.list_id} no longer exists.`);
  if (list.kind !== "static") {
    return failed("add_to_list", `List ${action.list_id} is a smart list; use a static list.`);
  }
  const targets = pick(run, action.max_people);
  if (targets.length === 0) return skipped("add_to_list", "No contactable people for this signal.");
  const inserted = await run.ctx.db
    .insert(list_members)
    .values(
      targets.map((person) => ({
        list_id: list.id,
        person_id: person.id,
        added_at: run.ctx.clock.now(),
        added_by: { type: "system" as const, id: `automation:${run.rule.id}`, name: run.rule.name },
      })),
    )
    .onConflictDoNothing()
    .returning({ person_id: list_members.person_id });
  return { type: "add_to_list", status: "ok", count: inserted.length };
}

async function runResearch(
  run: ActionRun,
  action: Extract<StoredAction, { type: "research" }>,
): Promise<AutomationActionResult> {
  const target = action.target ?? "both";
  const personIds =
    target === "company" ? [] : pick(run, action.max_people).map((person) => person.id);
  const companyIds = target !== "people" && run.subject.company ? [run.subject.company.id] : [];
  if (personIds.length === 0 && companyIds.length === 0) {
    return skipped("research", "Nothing to research for this signal.");
  }
  const result = await requestResearch(run.ctx, { personIds, companyIds });
  return {
    type: "research",
    status: "ok",
    count: result.jobIds.length + result.cachedBriefIds.length,
    detail: `${result.jobIds.length} research jobs queued, ${result.cachedBriefIds.length} fresh briefs reused.`,
  };
}

/** Payload sent by the webhook action (documented for receivers). */
export function webhookPayload(run: ActionRun, now: Date) {
  const { signal, company } = run.subject;
  return {
    type: "automation.fired",
    delivery_id: run.firingId,
    occurred_at: now.toISOString(),
    rule: { id: run.rule.id, name: run.rule.name },
    signal: {
      id: signal.id,
      definition_key: signal.definition_key,
      title: signal.title,
      score: signal.score,
      strength: signal.strength,
      evidence_url: signal.evidence_url,
      evidence_excerpt: signal.evidence_excerpt,
      occurred_at: signal.occurred_at?.toISOString() ?? null,
      detected_at: signal.detected_at.toISOString(),
    },
    company: company ? { id: company.id, name: company.name, domain: company.domain } : null,
    people: run.people.slice(0, 10).map((person) => ({
      id: person.id,
      full_name: person.full_name,
      title: person.title,
      email: person.email,
      linkedin_url: person.linkedin_url,
    })),
  };
}

async function runWebhook(
  run: ActionRun,
  action: Extract<StoredAction, { type: "webhook" }>,
): Promise<AutomationActionResult> {
  const now = run.ctx.clock.now();
  const body = JSON.stringify(webhookPayload(run, now));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "openoutbound-event": "automation.fired",
    "openoutbound-delivery": run.firingId,
  };
  if (action.secret_id) {
    const secret = await run.ctx.vault.getSecret(action.secret_id, run.subject.signal.workspace_id);
    if (!secret)
      return failed("webhook", "The signing secret is gone; update the rule's webhook secret.");
    headers["openoutbound-signature"] = signWebhookBody(
      secret,
      body,
      Math.floor(now.getTime() / 1000),
    );
  }
  let response: Response;
  try {
    response = await run.ctx.fetch(action.url, {
      method: "POST",
      body,
      headers,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
  } catch (error) {
    return failed(
      "webhook",
      `POST failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Drain the body so the connection is released; receivers' answers are not used.
  await response.text().catch(() => "");
  if (!response.ok) return failed("webhook", `Receiver answered HTTP ${response.status}.`);
  return { type: "webhook", status: "ok", detail: `HTTP ${response.status}` };
}

async function runEnroll(
  run: ActionRun,
  action: Extract<StoredAction, { type: "enroll" }>,
): Promise<AutomationActionResult> {
  const { signal } = run.subject;
  const [campaign] = await run.ctx.db
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(
      and(eq(campaigns.workspace_id, signal.workspace_id), eq(campaigns.id, action.campaign_id)),
    );
  if (!campaign || campaign.status === "archived" || campaign.status === "completed") {
    return failed("enroll", `Campaign ${action.campaign_id} is missing, completed or archived.`);
  }
  const targets = pick(run, action.max_people);
  if (targets.length === 0) return skipped("enroll", "No contactable people for this signal.");
  const personIds = targets.map((person) => person.id);
  const source = `automation:${run.rule.id}`;

  if (run.rule.require_approval || !run.enrollEventAvailable) {
    const names = targets.map(personName).join(", ");
    const approval = await run.ctx.approvals.request({
      kind: "enrollment",
      title: `Enroll ${targets.length} ${targets.length === 1 ? "person" : "people"} in "${campaign.name}"`,
      summary: `Automation "${run.rule.name}" matched the signal "${signal.title}" (${signal.definition_key}, score ${signal.score}). Approving enrolls ${names} after the campaign's usual checks.`,
      payload: {
        campaign_id: campaign.id,
        person_ids: personIds,
        source,
        rule_id: run.rule.id,
        signal_id: signal.id,
      },
      target: { type: "campaign", id: campaign.id },
      workspaceId: signal.workspace_id,
    });
    return {
      type: "enroll",
      status: "approval_requested",
      count: personIds.length,
      approval_id: approval.id,
      detail: run.rule.require_approval
        ? "Waiting for approval (require_approval is on)."
        : "Sent for approval because this engine cannot hand enrollments to campaigns directly yet.",
    };
  }

  const data = {
    rule_id: run.rule.id,
    campaign_id: campaign.id,
    person_ids: personIds,
    signal_id: signal.id,
  };
  await run.ctx.events.emit(ENROLL_REQUESTED as EventType, {
    workspaceId: signal.workspace_id,
    subject: { type: "campaign", id: campaign.id },
    data: data as unknown as EventData[EventType],
  });
  return {
    type: "enroll",
    status: "ok",
    count: personIds.length,
    detail: `Requested for "${campaign.name}".`,
  };
}

async function runTag(
  run: ActionRun,
  action: Extract<StoredAction, { type: "tag" }>,
): Promise<AutomationActionResult> {
  const target = action.target ?? "company";
  const tag = action.tag.trim().toLowerCase();
  let count = 0;
  const { company } = run.subject;
  if (target !== "people" && company) {
    const updated = await run.ctx.db
      .update(companies)
      .set({ tags: sql`array_append(${companies.tags}, ${tag})` })
      .where(and(eq(companies.id, company.id), sql`not (${tag} = any(${companies.tags}))`))
      .returning({ id: companies.id });
    count += updated.length;
  }
  if (target !== "company" && run.people.length > 0) {
    const updated = await run.ctx.db
      .update(people)
      .set({ tags: sql`array_append(${people.tags}, ${tag})` })
      .where(
        and(
          inArray(
            people.id,
            run.people.slice(0, DEFAULT_PEOPLE_PER_ACTION).map((person) => person.id),
          ),
          sql`not (${tag} = any(${people.tags}))`,
        ),
      )
      .returning({ id: people.id });
    count += updated.length;
  }
  return { type: "tag", status: "ok", count };
}

/** Runs one stored action. Never throws: failures are returned as `failed` results. */
export async function executeAction(
  run: ActionRun,
  action: StoredAction,
): Promise<AutomationActionResult> {
  try {
    switch (action.type) {
      case "notify":
        return await runNotify(run, action);
      case "add_to_list":
        return await runAddToList(run, action);
      case "research":
        return await runResearch(run, action);
      case "webhook":
        return await runWebhook(run, action);
      case "enroll":
        return await runEnroll(run, action);
      case "tag":
        return await runTag(run, action);
      default:
        return failed(String((action as { type?: unknown }).type), "Unknown action type.");
    }
  } catch (error) {
    return failed(action.type, error instanceof Error ? error.message : String(error));
  }
}

/** What an action would do, without doing it (automations.test). */
export function previewAction(
  action: StoredAction,
  people: Person[],
  subject: AutomationSubject,
  requireApproval: boolean,
): string {
  const count = (max: number | undefined) =>
    Math.min(people.length, Math.max(1, max ?? DEFAULT_PEOPLE_PER_ACTION));
  switch (action.type) {
    case "notify":
      return "Send a notification to the workspace channels.";
    case "add_to_list":
      return `Add ${count(action.max_people)} people to list ${action.list_id}.`;
    case "research": {
      const target = action.target ?? "both";
      const parts = [
        target !== "company" ? `${count(action.max_people)} people` : null,
        target !== "people" && subject.company ? "the company" : null,
      ].filter(Boolean);
      return parts.length > 0
        ? `Request research on ${parts.join(" and ")}.`
        : "Nothing to research.";
    }
    case "webhook":
      return `POST the signal to ${new URL(action.url).host}${action.secret_id ? " (signed)" : ""}.`;
    case "enroll":
      return requireApproval
        ? `Ask for approval to enroll ${count(action.max_people)} people in campaign ${action.campaign_id}.`
        : `Enroll ${count(action.max_people)} people in campaign ${action.campaign_id}.`;
    case "tag":
      return `Tag the ${action.target ?? "company"} with "${action.tag}".`;
    default:
      return "Unknown action.";
  }
}
